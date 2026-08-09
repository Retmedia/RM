const { execFile } = require('node:child_process');
const path = require('node:path');
const { promisify } = require('node:util');
const { isSafeChannelUrl } = require('./utils');

const execFileP = promisify(execFile);

const YT_DLP = path.resolve(
  __dirname, '..', 'bin',
  process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
);

async function listChannelVideos(channelUrl, signal) {
  if (!isSafeChannelUrl(channelUrl)) {
    throw new Error('Refusing to run yt-dlp on a non-YouTube URL');
  }
  const args = [
    '--flat-playlist',
    '--dump-json',
    '--no-warnings',
    '--ignore-errors',
    channelUrl,
  ];
  const { stdout } = await execFileP(YT_DLP, args, {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: 5 * 60 * 1000,
    signal,
  });

  const videos = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const v = JSON.parse(trimmed);
      if (v.id) videos.push(v);
    } catch { /* skip malformed lines */ }
  }
  return videos;
}

async function getChannelMetadata(channelUrl, signal) {
  if (!isSafeChannelUrl(channelUrl)) {
    throw new Error('Refusing to run yt-dlp on a non-YouTube URL');
  }
  const args = [
    '--playlist-items', '0',
    '--dump-single-json',
    '--no-warnings',
    channelUrl,
  ];
  const { stdout } = await execFileP(YT_DLP, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60 * 1000,
    signal,
  });
  return JSON.parse(stdout);
}

module.exports = { listChannelVideos, getChannelMetadata, YT_DLP };
