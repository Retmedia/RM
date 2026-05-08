const { execFile } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs/promises');
const { promisify } = require('node:util');
const { isVideoId, sleep } = require('./utils');
const { YT_DLP } = require('./youtube');

const execFileP = promisify(execFile);

// Heuristics for "this is permanently unavailable, don't retry"
const PERMANENT_REASONS = [
  /no\s+(automatic\s+)?captions/i,
  /subtitles?\s+are\s+disabled/i,
  /requested\s+format/i,
  /video\s+unavailable/i,
  /private\s+video/i,
  /sign\s+in\s+to\s+confirm\s+your\s+age/i,
  /members[- ]only/i,
  /this\s+video\s+is\s+(unavailable|private)/i,
];

// Transient network blip — short backoff is enough.
const RETRY_DELAYS_MS = [500, 2000, 5000];

// HTTP 429 / Too Many Requests. YouTube doesn't forgive these in seconds —
// give it real time before retrying. Without this, a small channel can
// rate-limit out and false-flag dozens of videos as "no captions".
const RATE_LIMIT_DELAYS_MS = [10_000, 30_000, 90_000];

function isPermanent(stderr) {
  return PERMANENT_REASONS.some((re) => re.test(stderr));
}

function isRateLimited(stderr) {
  return /HTTP\s*Error\s*429|Too\s+Many\s+Requests|rate[- ]?limit/i.test(stderr);
}

// Run yt-dlp, optionally registering the spawned child on a controller so
// cancelJob() can SIGTERM it and skip the (up-to-3-minute) timeout. Also
// requests --write-info-json so we capture upload_date / view_count /
// description / etc. — fields that --flat-playlist (used during channel
// listing) doesn't include, so the CSV would otherwise have blank columns.
function runYtDlp(videoId, workDir, language, controller) {
  const outTemplate = path.join(workDir, '%(id)s.%(ext)s');
  const args = [
    '--skip-download',
    '--write-auto-subs',
    '--write-subs',
    // Match more variants. YouTube returns auto-captions as `<lang>-orig`,
    // manual subs as `<lang>` or `<lang>-XX`, and auto-translated as `a.<lang>`.
    // We catch all of them so `en` doesn't miss `en-orig` / `en-US` / `a.en`.
    '--sub-langs', `${language}-orig,${language}.*,${language},a.${language}`,
    '--sub-format', 'vtt/best',
    '--write-info-json',
    '--no-warnings',
    '-o', outTemplate,
    `https://www.youtube.com/watch?v=${videoId}`,
  ];
  return new Promise((resolve, reject) => {
    const child = execFile(YT_DLP, args, {
      encoding: 'utf8',
      timeout: 3 * 60 * 1000,
      maxBuffer: 16 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (controller && controller.currentChild === child) controller.currentChild = null;
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
    if (controller) controller.currentChild = child;
  });
}

// Read the .info.json yt-dlp wrote during the pull (best-effort) and pluck
// out the fields we care about. yt-dlp writes the info file early in its
// pipeline, so we usually have it even when subtitle download fails.
async function readVideoInfo(workDir, videoId) {
  const infoPath = path.join(workDir, `${videoId}.info.json`);
  try {
    const raw = await fs.readFile(infoPath, 'utf8');
    const info = JSON.parse(raw);
    return {
      title: info.title ?? null,
      description: info.description ?? null,
      duration: typeof info.duration === 'number' ? info.duration : null,
      upload_date: info.upload_date ?? null,           // "20240105"
      view_count: typeof info.view_count === 'number' ? info.view_count : null,
      thumbnail: info.thumbnail ?? null,
      channel: info.channel ?? null,
      channel_id: info.channel_id ?? null,
    };
  } catch {
    return null;
  }
}

// Probe what subtitle/auto-caption tracks YouTube actually has for a video,
// without downloading anything. Returns an array of language codes (deduped,
// sorted) or null if the probe itself failed. Used as a diagnostic fallback
// when our regular pull came back empty — so we can tell the operator
// "captions exist in es, fr — but you asked for en" instead of just
// "no transcript available".
async function probeAvailableLanguages(videoId) {
  if (!isVideoId(videoId)) return null;
  try {
    const { stdout } = await execFileP(YT_DLP, [
      '--dump-json',
      '--skip-download',
      '--no-warnings',
      `https://www.youtube.com/watch?v=${videoId}`,
    ], { encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
    const meta = JSON.parse(stdout);
    const langs = new Set();
    for (const k of Object.keys(meta.subtitles || {})) langs.add(k);
    for (const k of Object.keys(meta.automatic_captions || {})) langs.add(k);
    // Drop the noise that's not a real human language code.
    const cleaned = [...langs]
      .filter((l) => /^[a-z]{2,3}(?:[-.][A-Za-z0-9]+)?$/.test(l))
      .sort();
    return cleaned;
  } catch {
    return null;
  }
}

async function pullTranscript(videoId, workDir, language = 'en', controller = null) {
  if (!isVideoId(videoId)) throw new Error('Invalid video id');
  await fs.mkdir(workDir, { recursive: true });

  const MAX_ATTEMPTS = 4; // initial + 3 retries
  let lastErr = null;
  let rateLimited = false;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (controller && controller.abort) {
      return { ok: false, reason: 'cancelled', cancelled: true };
    }
    try {
      await runYtDlp(videoId, workDir, language, controller);
      lastErr = null;
      rateLimited = false;
      break;
    } catch (e) {
      // SIGTERM from cancelJob shows up as a child-process error; treat it
      // as a clean cancel rather than retrying or marking the video failed.
      if (controller && controller.abort) {
        return { ok: false, reason: 'cancelled', cancelled: true };
      }
      const stderr = (e.stderr || e.message || '').toString();
      lastErr = stderr.slice(0, 500);
      if (isPermanent(stderr)) {
        // Even on permanent failures yt-dlp may have written the info JSON
        // before bailing — pick it up so the CSV gets dates / view counts.
        const info = await readVideoInfo(workDir, videoId);
        const available_languages = await probeAvailableLanguages(videoId);
        return { ok: false, reason: lastErr, permanent: true, available_languages, info };
      }
      const isRL = isRateLimited(stderr);
      rateLimited = isRL;
      const isLastAttempt = attempt >= MAX_ATTEMPTS - 1;
      if (isLastAttempt) {
        const info = await readVideoInfo(workDir, videoId);
        return { ok: false, reason: lastErr, rateLimited, info };
      }
      const delays = isRL ? RATE_LIMIT_DELAYS_MS : RETRY_DELAYS_MS;
      await sleep(delays[attempt] ?? delays[delays.length - 1]);
    }
  }

  const info = await readVideoInfo(workDir, videoId);
  const entries = await fs.readdir(workDir);
  const vttFile = entries.find((f) => f.startsWith(videoId) && f.endsWith('.vtt'));
  if (!vttFile) {
    // yt-dlp returned 0 but didn't write a VTT — almost always means the
    // requested language wasn't available (foreign-language video).
    const available_languages = await probeAvailableLanguages(videoId);
    const reason = available_languages && available_languages.length
      ? `No captions in ${language}. YouTube has: ${available_languages.slice(0, 8).join(', ')}${available_languages.length > 8 ? '…' : ''}`
      : 'No captions on YouTube for this video';
    return { ok: false, reason, permanent: true, available_languages, info };
  }

  const fullPath = path.join(workDir, vttFile);
  const raw = await fs.readFile(fullPath, 'utf8');
  const segments = parseVTT(raw);
  return { ok: true, segments, raw, file: vttFile, path: fullPath, info };
}

// Lightweight metadata-only fetch — used by the "Refresh metadata" job to
// backfill upload_date / view_count on existing channels without re-pulling
// captions. Much faster than pullTranscript because no subtitles cross the
// wire; just the video metadata page.
async function fetchVideoMetadata(videoId, workDir, controller = null) {
  if (!isVideoId(videoId)) throw new Error('Invalid video id');
  await fs.mkdir(workDir, { recursive: true });
  const outTemplate = path.join(workDir, '%(id)s.%(ext)s');
  const args = [
    '--skip-download',
    '--write-info-json',
    '--no-warnings',
    '-o', outTemplate,
    `https://www.youtube.com/watch?v=${videoId}`,
  ];
  return new Promise((resolve, reject) => {
    const child = execFile(YT_DLP, args, {
      encoding: 'utf8',
      timeout: 60 * 1000,
      maxBuffer: 16 * 1024 * 1024,
    }, async (err) => {
      if (controller && controller.currentChild === child) controller.currentChild = null;
      if (err && !(controller && controller.abort)) {
        // Even on error yt-dlp often writes info.json. Try to read it before
        // giving up so callers still get whatever metadata is available.
        const info = await readVideoInfo(workDir, videoId);
        if (info) return resolve(info);
        return reject(err);
      }
      const info = await readVideoInfo(workDir, videoId);
      resolve(info);
    });
    if (controller) controller.currentChild = child;
  });
}

function parseVTT(vtt) {
  const lines = vtt.split(/\r?\n/);
  const segments = [];
  let i = 0;
  while (i < lines.length && !/-->/.test(lines[i])) i++;

  while (i < lines.length) {
    const m = lines[i].match(
      /(\d+):(\d+):(\d+)[.,](\d+)\s*-->\s*(\d+):(\d+):(\d+)[.,](\d+)/
    );
    if (!m) { i++; continue; }
    const start = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
    const end   = (+m[5]) * 3600 + (+m[6]) * 60 + (+m[7]) + (+m[8]) / 1000;
    i++;
    const buf = [];
    while (i < lines.length && lines[i].trim() !== '') {
      buf.push(stripVttTags(lines[i]));
      i++;
    }
    while (i < lines.length && lines[i].trim() === '') i++;
    const text = collapseRepeats(buf.join(' ').replace(/\s+/g, ' ').trim());
    if (text) segments.push({ start, end, text });
  }
  return segments;
}

function stripVttTags(line) {
  return line
    .replace(/<\d+:\d+:\d+\.\d+>/g, '')
    .replace(/<\/?[cv][^>]*>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function collapseRepeats(s) {
  return s.replace(/\b(\w+)( \1\b)+/gi, '$1');
}

module.exports = { pullTranscript, parseVTT, probeAvailableLanguages, fetchVideoMetadata, readVideoInfo, isPermanent, isRateLimited };
