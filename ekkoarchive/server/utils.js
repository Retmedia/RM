const path = require('node:path');
const fs = require('node:fs/promises');

function isSafeChannelUrl(input) {
  if (typeof input !== 'string' || input.length > 2048) return false;
  let u;
  try { u = new URL(input); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  return /(^|\.)youtube\.com$/i.test(u.hostname) || u.hostname.toLowerCase() === 'youtu.be';
}

function isVideoId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id);
}

function slugify(input) {
  return String(input || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'untitled';
}

async function writeJSONAtomic(filepath, data) {
  const tmp = `${filepath}.${process.pid}.${Date.now()}.tmp`;
  await fs.mkdir(path.dirname(filepath), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, filepath);
}

async function readJSONIfExists(filepath, fallback = null) {
  try {
    const raw = await fs.readFile(filepath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = {
  isSafeChannelUrl,
  isVideoId,
  slugify,
  writeJSONAtomic,
  readJSONIfExists,
  sleep,
};
