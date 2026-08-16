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

// Accepts "@handle", "youtube.com/@handle", or a full URL. Returns a canonical
// https URL, or null if it isn't YouTube.
function normalizeChannelUrl(input) {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (!raw) return null;
  if (/^@[A-Za-z0-9_.-]{3,30}$/.test(raw)) return `https://www.youtube.com/${raw}`;
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  if (!isSafeChannelUrl(withProtocol)) return null;
  const u = new URL(withProtocol);
  u.hostname = u.hostname.toLowerCase() === 'youtu.be' ? 'youtu.be' : 'www.youtube.com';
  u.hash = '';
  return u.toString().replace(/\/$/, '');
}

const CHANNEL_TABS = ['videos', 'shorts', 'streams', 'playlists', 'featured', 'community'];

// YouTube already separates long-form from Shorts: the /videos tab excludes
// Shorts and live streams, which is exactly the "long form only" list we want.
function channelVideosUrl(input) {
  const url = normalizeChannelUrl(input);
  if (!url) return null;
  const u = new URL(url);
  const segments = u.pathname.split('/').filter(Boolean);
  if (!segments.length) return url;
  const last = segments[segments.length - 1];
  if (CHANNEL_TABS.includes(last.toLowerCase())) return url;
  const isChannelRoot =
    last.startsWith('@') ||
    (segments.length === 2 && ['channel', 'c', 'user'].includes(segments[0].toLowerCase()));
  if (!isChannelRoot) return url; // a playlist or single video URL — leave it alone
  u.pathname = `/${segments.join('/')}/videos`;
  return u.toString();
}

function csvEscape(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(headers, rows) {
  const lines = [headers.map(csvEscape).join(',')];
  for (const row of rows) lines.push(headers.map((h) => csvEscape(row[h])).join(','));
  return `${lines.join('\n')}\n`;
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
  normalizeChannelUrl,
  channelVideosUrl,
  csvEscape,
  toCsv,
  slugify,
  writeJSONAtomic,
  readJSONIfExists,
  sleep,
};
