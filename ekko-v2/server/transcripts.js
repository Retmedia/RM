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
    '--sub-langs', `${language}.*,${language}`,
    '--sub-format', 'vtt',
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
        return { ok: false, reason: lastErr, permanent: true };
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
  if (!vttFile) return { ok: false, reason: 'no transcript available', permanent: true };

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

module.exports = { pullTranscript, parseVTT, isPermanent, isRateLimited };
