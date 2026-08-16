'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { YT_DLP } = require('./youtube');
const { isVideoId, runPool } = require('./util');

const execFileP = promisify(execFile);

/**
 * Asks YouTube what a video is actually available in, without downloading it.
 *
 * A flat channel listing says nothing about resolution, so estimating from a
 * bitrate table is guesswork. Sampling a handful of real videos turns both the
 * "will I actually get 4K?" question and the size estimate into measurements.
 */
async function probeVideo(videoId) {
  if (!isVideoId(videoId)) return null;
  try {
    const { stdout } = await execFileP(YT_DLP, [
      '--dump-json',
      '--skip-download',
      '--no-warnings',
      `https://www.youtube.com/watch?v=${videoId}`,
    ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 90 * 1000 });
    const info = JSON.parse(stdout);
    return {
      id: info.id,
      duration: info.duration || 0,
      formats: (info.formats || []).map((f) => ({
        height: f.height || 0,
        fps: f.fps || 0,
        vcodec: String(f.vcodec || 'none'),
        acodec: String(f.acodec || 'none'),
        tbr: f.tbr || 0,
        filesize: f.filesize || f.filesize_approx || 0,
      })),
    };
  } catch {
    return null;
  }
}

function formatBytes(format, duration) {
  if (format.filesize) return format.filesize;
  if (format.tbr && duration) return Math.round((format.tbr * 1000 / 8) * duration);
  return 0;
}

// Mirrors the -f/-S selection yt-dlp will actually make, so the estimate
// reflects the stream that really gets downloaded.
function pickFormats(probe, { height, fps, preferCodec }) {
  const videos = probe.formats.filter((f) => f.vcodec !== 'none' && f.height > 0 && f.height <= height);
  const audios = probe.formats.filter((f) => f.acodec !== 'none' && f.vcodec === 'none');
  if (!videos.length) return null;

  const best = [...videos].sort((a, b) => {
    if (b.height !== a.height) return b.height - a.height;
    const aFps = Math.abs((a.fps || 30) - fps);
    const bFps = Math.abs((b.fps || 30) - fps);
    if (aFps !== bFps) return aFps - bFps;
    const aPref = preferCodec && a.vcodec.includes(codecTag(preferCodec)) ? 0 : 1;
    const bPref = preferCodec && b.vcodec.includes(codecTag(preferCodec)) ? 0 : 1;
    if (aPref !== bPref) return aPref - bPref;
    return (b.tbr || 0) - (a.tbr || 0);
  })[0];

  const audio = [...audios].sort((a, b) => {
    const aAac = a.acodec.startsWith('mp4a') ? 0 : 1;
    const bAac = b.acodec.startsWith('mp4a') ? 0 : 1;
    if (aAac !== bAac) return aAac - bAac;
    return (b.tbr || 0) - (a.tbr || 0);
  })[0];

  const bytes = formatBytes(best, probe.duration) + (audio ? formatBytes(audio, probe.duration) : 0);
  return { height: best.height, fps: best.fps || 0, vcodec: best.vcodec.split('.')[0], bytes };
}

function codecTag(preferCodec) {
  if (preferCodec === 'h264') return 'avc';
  if (preferCodec === 'vp9') return 'vp';
  return preferCodec;
}

/**
 * Samples across the catalogue — newest, middle and oldest — because upload
 * quality changes over a channel's life and sampling only recent uploads would
 * flatter the estimate.
 */
function pickSample(videos, size) {
  if (videos.length <= size) return [...videos];
  const step = videos.length / size;
  return Array.from({ length: size }, (_, i) => videos[Math.floor(i * step)]);
}

async function probeCatalogue(videos, settings, sampleSize = 12, concurrency = 5) {
  const sample = pickSample(videos, sampleSize);
  const results = [];

  await runPool(sample, concurrency, async (video) => {
    const probe = await probeVideo(video.id);
    if (!probe) return;
    const picked = pickFormats(probe, settings);
    if (picked && probe.duration > 0) {
      results.push({ ...picked, duration: probe.duration, bytesPerSec: picked.bytes / probe.duration });
    }
  });

  if (!results.length) return null;

  const tiers = {};
  for (const r of results) {
    const tier = r.height >= 2160 ? '2160' : r.height >= 1440 ? '1440' : r.height >= 1080 ? '1080' : 'lower';
    tiers[tier] = (tiers[tier] || 0) + 1;
  }

  const measured = results.filter((r) => r.bytes > 0);
  const bytesPerSec = measured.length
    ? measured.reduce((sum, r) => sum + r.bytesPerSec, 0) / measured.length
    : 0;

  return {
    sampled: results.length,
    tiers,
    bytesPerSec,
    reliable: measured.length >= Math.max(3, Math.floor(results.length / 2)),
  };
}

module.exports = { probeVideo, probeCatalogue, pickFormats, pickSample };
