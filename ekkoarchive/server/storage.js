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
  const dirs = entries.filter((e) => e.isDirectory());
  const metas = await Promise.all(
    dirs.map((e) =>
      readJSONIfExists(path.join(VAULT_ROOT, e.name, 'channel.json'))
        .then((meta) => (meta ? { key: e.name, ...meta } : null))
    )
  );
  return metas.filter(Boolean);
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
    const files = entries.filter((f) => f.endsWith('.json'));
    const loaded = await Promise.all(files.map((f) => readJSONIfExists(path.join(dir, f))));
    const videos = loaded.filter(Boolean);
    videos.sort((a, b) => String(b.upload_date || '').localeCompare(String(a.upload_date || '')));
    return videos;
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

// Return the saved plaintext transcript for a video, or null if none exists.
async function getTranscriptText(channelKey, videoId) {
  const filePath = path.join(transcriptDir(channelKey), `${videoId}.txt`);
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
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
  getTranscriptText,
};
