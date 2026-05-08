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

async function runYtDlp(videoId, workDir, language) {
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
    '--no-warnings',
    '-o', outTemplate,
    `https://www.youtube.com/watch?v=${videoId}`,
  ];
  return execFileP(YT_DLP, args, {
    encoding: 'utf8',
    timeout: 3 * 60 * 1000,
    maxBuffer: 16 * 1024 * 1024,
  });
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

async function pullTranscript(videoId, workDir, language = 'en') {
  if (!isVideoId(videoId)) throw new Error('Invalid video id');
  await fs.mkdir(workDir, { recursive: true });

  const MAX_ATTEMPTS = 4; // initial + 3 retries
  let lastErr = null;
  let rateLimited = false;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      await runYtDlp(videoId, workDir, language);
      lastErr = null;
      rateLimited = false;
      break;
    } catch (e) {
      const stderr = (e.stderr || e.message || '').toString();
      lastErr = stderr.slice(0, 500);
      if (isPermanent(stderr)) {
        // Even on permanent failures, probe languages so the UI can suggest
        // a workaround (e.g. paste manually, or re-pull with a different lang).
        const available_languages = await probeAvailableLanguages(videoId);
        return { ok: false, reason: lastErr, permanent: true, available_languages };
      }
      const isRL = isRateLimited(stderr);
      rateLimited = isRL;
      const isLastAttempt = attempt >= MAX_ATTEMPTS - 1;
      if (isLastAttempt) {
        return { ok: false, reason: lastErr, rateLimited };
      }
      const delays = isRL ? RATE_LIMIT_DELAYS_MS : RETRY_DELAYS_MS;
      await sleep(delays[attempt] ?? delays[delays.length - 1]);
    }
  }

  const entries = await fs.readdir(workDir);
  const vttFile = entries.find((f) => f.startsWith(videoId) && f.endsWith('.vtt'));
  if (!vttFile) {
    // yt-dlp returned 0 but didn't write a VTT — almost always means the
    // requested language wasn't available (foreign-language video).
    const available_languages = await probeAvailableLanguages(videoId);
    const reason = available_languages && available_languages.length
      ? `No captions in ${language}. YouTube has: ${available_languages.slice(0, 8).join(', ')}${available_languages.length > 8 ? '…' : ''}`
      : 'No captions on YouTube for this video';
    return { ok: false, reason, permanent: true, available_languages };
  }

  const fullPath = path.join(workDir, vttFile);
  const raw = await fs.readFile(fullPath, 'utf8');
  const segments = parseVTT(raw);
  return { ok: true, segments, raw, file: vttFile, path: fullPath };
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

module.exports = { pullTranscript, parseVTT, probeAvailableLanguages, isPermanent, isRateLimited };
