const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const { isVideoId } = require('./utils');
const { YT_DLP } = require('./youtube');

const DEFAULT_HEIGHT = 1080;
const DEFAULT_FPS = 60;

// Sorts oldest-to-newest in Finder, keeps the id so re-runs can dedupe.
const OUTPUT_TEMPLATE = '%(upload_date>%Y-%m-%d)s - %(title).80B [%(id)s].%(ext)s';
const PROGRESS_TAG = '@@EKKO@@';

const BIN_DIR = path.resolve(__dirname, '..', 'bin');

function bundledFfmpeg() {
  const p = path.join(BIN_DIR, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  return fsSync.existsSync(p) ? p : null;
}

// yt-dlp needs ffmpeg to merge the separate 1080p video and audio streams that
// YouTube serves. Without it you silently get a lower-quality single-file format.
function checkFfmpeg() {
  if (bundledFfmpeg()) return Promise.resolve({ ok: true, source: 'bundled' });
  return new Promise((resolve) => {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const child = spawn(finder, ['ffmpeg'], { stdio: 'ignore' });
    child.on('error', () => resolve({ ok: false, source: null }));
    child.on('close', (code) => resolve({ ok: code === 0, source: code === 0 ? 'path' : null }));
  });
}

function ytDlpInstalled() {
  return fsSync.existsSync(YT_DLP);
}

function formatSelectionArgs({ height = DEFAULT_HEIGHT, fps = DEFAULT_FPS, preferH264 = true }) {
  // The -f filter is a hard ceiling; -S ranks what survives it. Priority order
  // matters: resolution first, then frame rate, then codecs an NLE likes.
  const sort = [`res:${height}`, `fps:${fps}`];
  if (preferH264) sort.push('vcodec:h264', 'acodec:aac');
  sort.push('br');
  return [
    '-f', `bv*[height<=${height}]+ba/b[height<=${height}]/bv*+ba/b`,
    '-S', sort.join(','),
    '--merge-output-format', 'mp4',
  ];
}

/**
 * Download one video. Resolves with {ok, file, info} or {ok:false, reason};
 * it never throws for a download failure so a bulk run can keep going.
 */
function downloadVideo(videoId, destDir, opts = {}, onProgress) {
  if (!isVideoId(videoId)) return Promise.reject(new Error('Invalid video id'));

  const args = [
    ...formatSelectionArgs(opts),
    '-o', path.join(destDir, opts.outputTemplate || OUTPUT_TEMPLATE),
    '--trim-filenames', '200',
    '--no-playlist',
    '--no-overwrites',
    '--continue',
    '--embed-metadata',
    '--concurrent-fragments', String(opts.fragments || 4),
    '--retries', '5',
    '--fragment-retries', '10',
    '--no-warnings',
    '--newline',
    '--progress',
    '--progress-template',
    `download:${PROGRESS_TAG} %(progress._percent_str)s %(progress._speed_str)s %(progress._eta_str)s`,
    '--no-simulate',
    '--dump-json',
  ];

  const ffmpeg = bundledFfmpeg();
  if (ffmpeg) args.push('--ffmpeg-location', ffmpeg);
  if (opts.cookiesFromBrowser) args.push('--cookies-from-browser', opts.cookiesFromBrowser);
  args.push(`https://www.youtube.com/watch?v=${videoId}`); // URL last

  return new Promise((resolve) => {
    const child = spawn(YT_DLP, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let info = null;
    let stdoutTail = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) child.kill('SIGKILL');
    }, opts.timeoutMs || 60 * 60 * 1000);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutTail += chunk;
      const lines = stdoutTail.split('\n');
      stdoutTail = lines.pop();
      for (const line of lines) handleLine(line);
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-4000);
    });

    function handleLine(line) {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (trimmed.startsWith(PROGRESS_TAG)) {
        if (!onProgress) return;
        const [, percent, speed, eta] = trimmed.split(/\s+/);
        onProgress({
          percent: Number.parseFloat(percent) || 0,
          speed: speed || null,
          eta: eta || null,
        });
        return;
      }
      if (trimmed.startsWith('{')) {
        try { info = JSON.parse(trimmed); } catch { /* not the info json */ }
      }
    }

    child.on('error', (err) => {
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, reason: `could not run yt-dlp: ${err.message}` });
    });

    child.on('close', (code) => {
      settled = true;
      clearTimeout(timer);
      if (stdoutTail.trim()) handleLine(stdoutTail);
      if (code !== 0 || !info) {
        return resolve({
          ok: false,
          reason: (stderr.trim() || `yt-dlp exited with code ${code}`).slice(0, 500),
        });
      }
      const requested = Array.isArray(info.requested_downloads) ? info.requested_downloads[0] : null;
      const file = requested?.filepath || info.filepath || info._filename || null;
      resolve({ ok: true, file, info });
    });

    if (opts.controller) {
      const poll = setInterval(() => {
        if (opts.controller.abort && !settled) child.kill('SIGTERM');
        if (settled) clearInterval(poll);
      }, 500);
    }
  });
}

// Rough sizing so a 200-video run can be sanity-checked before it starts.
const BITRATE_MBPS = { 2160: 20, 1440: 9, 1080: 4.5, 720: 2.5, 480: 1.2, 360: 0.7 };

function estimateBytes(durationSec, height = DEFAULT_HEIGHT, fps = DEFAULT_FPS) {
  if (!durationSec || durationSec <= 0) return 0;
  const rungs = Object.keys(BITRATE_MBPS).map(Number).sort((a, b) => a - b);
  const rung = rungs.find((h) => h >= height) ?? rungs[rungs.length - 1];
  const video = BITRATE_MBPS[rung] * (fps >= 50 ? 1.4 : 1);
  return Math.round(((video + 0.13) * 1_000_000 / 8) * durationSec);
}

async function freeSpaceBytes(dir) {
  try {
    const stats = await fs.statfs(dir);
    return stats.bavail * stats.bsize;
  } catch {
    return null; // older Node, or an fs that can't report — treat as unknown
  }
}

function bytesToGb(bytes) {
  return Math.round((bytes / 1_000_000_000) * 10) / 10;
}

module.exports = {
  DEFAULT_HEIGHT,
  DEFAULT_FPS,
  OUTPUT_TEMPLATE,
  downloadVideo,
  checkFfmpeg,
  ytDlpInstalled,
  estimateBytes,
  freeSpaceBytes,
  bytesToGb,
};
