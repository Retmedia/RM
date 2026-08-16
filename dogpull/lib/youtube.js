'use strict';

const { spawn, execFile } = require('node:child_process');
const path = require('node:path');
const fsSync = require('node:fs');
const { promisify } = require('node:util');
const { isVideoId, isYouTubeUrl } = require('./util');

const execFileP = promisify(execFile);

const BIN_DIR = path.resolve(__dirname, '..', 'bin');
const IS_WINDOWS = process.platform === 'win32';
const YT_DLP = path.join(BIN_DIR, IS_WINDOWS ? 'yt-dlp.exe' : 'yt-dlp');
const PROGRESS_TAG = '@@DOGPULL@@';

function ytDlpInstalled() {
  return fsSync.existsSync(YT_DLP);
}

function bundledFfmpeg() {
  const p = path.join(BIN_DIR, IS_WINDOWS ? 'ffmpeg.exe' : 'ffmpeg');
  return fsSync.existsSync(p) ? p : null;
}

// yt-dlp needs ffmpeg to merge the separate video and audio streams YouTube
// serves above 720p. Without it you silently get a lower-quality single file.
function checkFfmpeg() {
  if (bundledFfmpeg()) return Promise.resolve({ ok: true, source: 'bundled' });
  return new Promise((resolve) => {
    const child = spawn(IS_WINDOWS ? 'where' : 'which', ['ffmpeg'], { stdio: 'ignore' });
    child.on('error', () => resolve({ ok: false, source: null }));
    child.on('close', (code) => resolve({ ok: code === 0, source: code === 0 ? 'path' : null }));
  });
}

async function getChannelMetadata(channelUrl) {
  if (!isYouTubeUrl(channelUrl)) throw new Error('Refusing to run yt-dlp on a non-YouTube URL');
  const { stdout } = await execFileP(YT_DLP, [
    '--playlist-items', '0',
    '--dump-single-json',
    '--no-warnings',
    channelUrl,
  ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 2 * 60 * 1000 });
  return JSON.parse(stdout);
}

async function listChannelVideos(channelUrl) {
  if (!isYouTubeUrl(channelUrl)) throw new Error('Refusing to run yt-dlp on a non-YouTube URL');
  const { stdout } = await execFileP(YT_DLP, [
    '--flat-playlist',
    '--dump-json',
    '--no-warnings',
    '--ignore-errors',
    channelUrl,
  ], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, timeout: 15 * 60 * 1000 });

  const videos = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const v = JSON.parse(trimmed);
      if (v.id && isVideoId(v.id)) videos.push(v);
    } catch { /* skip malformed lines */ }
  }
  return videos;
}

function formatArgs({ height, fps, preferCodec }) {
  // -f is a hard ceiling, -S ranks what survives it. Order matters: resolution,
  // then frame rate, then a codec the editor handles well, then bitrate.
  const sort = [`res:${height}`, `fps:${fps}`];
  if (preferCodec) sort.push(`vcodec:${preferCodec}`);
  // Prefer AAC over Opus: YouTube offers both, and Opus-in-MP4 trips up some
  // editors. Costs nothing in quality terms at these bitrates.
  sort.push('acodec:m4a', 'br');
  return [
    '-f', `bv*[height<=${height}]+ba/b[height<=${height}]/bv*+ba/b`,
    '-S', sort.join(','),
    '--merge-output-format', 'mp4',
    '--remux-video', 'mp4', // guarantees a .mp4 even when no merge happens
  ];
}

/**
 * Download one video to an exact path (minus extension, which yt-dlp fills in).
 * Resolves {ok, file, info} or {ok:false, reason} — it never rejects on a
 * download failure, so one bad video can't halt a 200-video run.
 */
function downloadVideo(videoId, outputBase, opts = {}, onProgress) {
  if (!isVideoId(videoId)) return Promise.resolve({ ok: false, reason: 'invalid video id' });

  const args = [
    ...formatArgs(opts),
    '-o', `${outputBase}.%(ext)s`,
    '--no-playlist',
    '--no-overwrites',
    '--continue',
    '--embed-metadata',
    '--concurrent-fragments', String(opts.fragments || 8),
    '--retries', '10',
    '--fragment-retries', '20',
    '--file-access-retries', '5',
    '--throttled-rate', '100K', // re-request if YouTube throttles the stream
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
  args.push(`https://www.youtube.com/watch?v=${videoId}`); // URL always last

  return new Promise((resolve) => {
    const child = spawn(YT_DLP, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let info = null;
    let pending = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) child.kill('SIGKILL');
    }, opts.timeoutMs || 3 * 60 * 60 * 1000);

    const poll = opts.controller ? setInterval(() => {
      if (opts.controller.abort && !settled) child.kill('SIGTERM');
    }, 500) : null;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) handleLine(line);
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });

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

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (poll) clearInterval(poll);
      resolve(result);
    }

    child.on('error', (err) => finish({ ok: false, reason: `could not run yt-dlp: ${err.message}` }));

    child.on('close', (code) => {
      if (pending.trim()) handleLine(pending);
      if (code !== 0 || !info) {
        const reason = stderr.trim().split('\n').filter(Boolean).pop() || `yt-dlp exited with code ${code}`;
        return finish({ ok: false, reason: reason.slice(0, 400) });
      }
      const requested = Array.isArray(info.requested_downloads) ? info.requested_downloads[0] : null;
      finish({ ok: true, file: requested?.filepath || info.filepath || info._filename || null, info });
    });
  });
}

module.exports = {
  YT_DLP,
  BIN_DIR,
  ytDlpInstalled,
  checkFfmpeg,
  bundledFfmpeg,
  getChannelMetadata,
  listChannelVideos,
  downloadVideo,
};
