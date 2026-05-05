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

function videosDir(channelKey) {
  return path.join(channelDir(channelKey), 'videos');
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
    if (e.name.startsWith('_')) continue;
    const meta = await readJSONIfExists(path.join(VAULT_ROOT, e.name, 'channel.json'));
    if (meta) channels.push({ key: e.name, ...meta });
  }
  channels.sort((a, b) => String(a.title || a.key).localeCompare(String(b.title || b.key)));
  return channels;
}

async function getChannel(channelKey) {
  const meta = await readJSONIfExists(path.join(channelDir(channelKey), 'channel.json'));
  return meta ? { key: channelKey, ...meta } : null;
}

async function saveChannelMeta(channelKey, meta) {
  await fs.mkdir(channelDir(channelKey), { recursive: true });
  await writeJSONAtomic(path.join(channelDir(channelKey), 'channel.json'), meta);
}

// Read-modify-write a single channel.json. Used for editing customer name,
// notes, delivered flag, and the rolled-up totals.
async function patchChannelMeta(channelKey, patch) {
  const file = path.join(channelDir(channelKey), 'channel.json');
  const current = (await readJSONIfExists(file)) || {};
  const next = { ...current, ...patch };
  await writeJSONAtomic(file, next);
  return next;
}

async function saveVideo(channelKey, video) {
  const dir = videosDir(channelKey);
  await fs.mkdir(dir, { recursive: true });
  await writeJSONAtomic(path.join(dir, `${video.id}.json`), video);
}

async function getVideo(channelKey, videoId) {
  return readJSONIfExists(path.join(videosDir(channelKey), `${videoId}.json`));
}

async function listVideos(channelKey) {
  try {
    const entries = await fs.readdir(videosDir(channelKey));
    const videos = [];
    for (const file of entries) {
      if (!file.endsWith('.json')) continue;
      const v = await readJSONIfExists(path.join(videosDir(channelKey), file));
      if (v) videos.push(v);
    }
    videos.sort((a, b) => String(b.upload_date || '').localeCompare(String(a.upload_date || '')));
    return videos;
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

async function readTranscriptVtt(channelKey, videoId) {
  const meta = await getVideo(channelKey, videoId);
  if (!meta || !meta.transcript_file) return null;
  const fullPath = path.join(transcriptDir(channelKey), meta.transcript_file);
  try {
    return await fs.readFile(fullPath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

// Walk the videos/ folder, sum word_count + count successful transcripts,
// and persist the rollup on the channel record. Called at the end of each
// archive job. Idempotent — safe to call multiple times.
async function recomputeChannelTotals(channelKey) {
  const videos = await listVideos(channelKey);
  const ok = videos.filter((v) => v.transcript_status === 'ok');
  const total_videos = ok.length;
  const total_words = ok.reduce((sum, v) => sum + (Number(v.word_count) || 0), 0);
  const last_pull_finished_at = new Date().toISOString();
  await patchChannelMeta(channelKey, { total_videos, total_words, last_pull_finished_at });
  return { total_videos, total_words, last_pull_finished_at };
}

// Vault-wide rollup for the Home view stats card. Cheap because it only
// reads channel.json files, not transcripts.
async function getVaultStats() {
  const channels = await listChannels();
  let total_videos = 0;
  let total_words = 0;
  for (const c of channels) {
    total_videos += Number(c.total_videos) || 0;
    total_words += Number(c.total_words) || 0;
  }
  return {
    channels: channels.length,
    delivered: channels.filter((c) => c.delivered).length,
    total_videos,
    total_words,
  };
}

// Permanently remove a channel folder. Safety: only operates inside VAULT_ROOT,
// and refuses anything that would escape via ".." or absolute path.
async function deleteChannel(channelKey) {
  if (!channelKey || typeof channelKey !== 'string') throw new Error('channelKey required');
  if (channelKey.includes('/') || channelKey.includes('..') || channelKey.startsWith('_')) {
    throw new Error('invalid channelKey');
  }
  const dir = channelDir(channelKey);
  // Belt-and-braces: ensure resolved path is inside VAULT_ROOT.
  if (!path.resolve(dir).startsWith(path.resolve(VAULT_ROOT) + path.sep)) {
    throw new Error('refusing to delete outside vault');
  }
  await fs.rm(dir, { recursive: true, force: true });
}

module.exports = {
  VAULT_ROOT,
  ensureVault,
  channelDir,
  transcriptDir,
  videosDir,
  makeChannelKey,
  listChannels,
  getChannel,
  saveChannelMeta,
  patchChannelMeta,
  saveVideo,
  getVideo,
  listVideos,
  readTranscriptVtt,
  recomputeChannelTotals,
  getVaultStats,
  deleteChannel,
};
