const path = require('node:path');
const fs = require('node:fs/promises');
const { writeJSONAtomic, readJSONIfExists, slugify } = require('./utils');

const VAULT_ROOT = process.env.EKKOARCHIVE_VAULT
  ? path.resolve(process.env.EKKOARCHIVE_VAULT)
  : path.resolve(__dirname, '..', '.archive-vault');

async function ensureVault() {
  await fs.mkdir(VAULT_ROOT, { recursive: true });
}

function channelDir(channelKey) {
  return path.join(VAULT_ROOT, channelKey);
}

function transcriptDir(channelKey) {
  return path.join(channelDir(channelKey), 'transcripts');
}

function makeChannelKey(meta) {
  const id = meta.channel_id || meta.uploader_id || meta.id || '';
  const handle = meta.uploader || meta.channel || meta.title || 'channel';
  return `${slugify(handle)}-${String(id).slice(-8) || 'x'}`;
}

async function listChannels() {
  await ensureVault();
  const entries = await fs.readdir(VAULT_ROOT, { withFileTypes: true });
  const channels = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const meta = await readJSONIfExists(path.join(VAULT_ROOT, e.name, 'channel.json'));
    if (meta) channels.push({ key: e.name, ...meta });
  }
  return channels;
}

async function saveChannelMeta(channelKey, meta) {
  await fs.mkdir(channelDir(channelKey), { recursive: true });
  await writeJSONAtomic(path.join(channelDir(channelKey), 'channel.json'), meta);
}

async function saveVideo(channelKey, video) {
  const dir = path.join(channelDir(channelKey), 'videos');
  await fs.mkdir(dir, { recursive: true });
  await writeJSONAtomic(path.join(dir, `${video.id}.json`), video);
}

async function getVideo(channelKey, videoId) {
  return readJSONIfExists(path.join(channelDir(channelKey), 'videos', `${videoId}.json`));
}

async function listVideos(channelKey) {
  const dir = path.join(channelDir(channelKey), 'videos');
  try {
    const entries = await fs.readdir(dir);
    const videos = [];
    for (const file of entries) {
      if (!file.endsWith('.json')) continue;
      const v = await readJSONIfExists(path.join(dir, file));
      if (v) videos.push(v);
    }
    videos.sort((a, b) => String(b.upload_date || '').localeCompare(String(a.upload_date || '')));
    return videos;
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

module.exports = {
  VAULT_ROOT,
  ensureVault,
  channelDir,
  transcriptDir,
  makeChannelKey,
  listChannels,
  saveChannelMeta,
  saveVideo,
  getVideo,
  listVideos,
};
