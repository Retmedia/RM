'use strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// macOS treats ":" as a path separator in Finder and "/" is illegal everywhere.
// Spaces are deliberately kept so filenames still read like the video titles.
const ILLEGAL = /[/\\:*?"<>|]/g;
const CONTROL = /[\x00-\x1f\x7f]/g;

function sanitizeTitle(title, maxLength = 150) {
  let name = String(title || '')
    .replace(CONTROL, '')
    .replace(ILLEGAL, '-')
    .replace(/\s+/g, ' ')
    .trim();
  name = name.replace(/^\.+/, '').replace(/[. ]+$/, ''); // no hidden files, no trailing dot/space
  if (name.length > maxLength) name = `${name.slice(0, maxLength).trim()}...`;
  return name || 'untitled';
}

function isVideoId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id);
}

function isYouTubeUrl(input) {
  if (typeof input !== 'string' || input.length > 2048) return false;
  let u;
  try { u = new URL(input); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  return /(^|\.)youtube\.com$/i.test(u.hostname) || u.hostname.toLowerCase() === 'youtu.be';
}

// The /videos tab already excludes Shorts and live streams — the cheapest and
// most reliable long-form filter there is.
function channelVideosUrl(input) {
  const raw = String(input || '').trim();
  const withProtocol = /^https?:\/\//i.test(raw)
    ? raw
    : `https://www.youtube.com/${raw.replace(/^\/+/, '')}`;
  if (!isYouTubeUrl(withProtocol)) return null;
  const u = new URL(withProtocol);
  u.hostname = 'www.youtube.com';
  u.hash = '';
  const segments = u.pathname.split('/').filter(Boolean);
  if (!segments.length) return null;
  const last = segments[segments.length - 1].toLowerCase();
  if (['videos', 'shorts', 'streams', 'playlists', 'featured'].includes(last)) return u.toString();
  const isChannelRoot =
    segments[0].startsWith('@') ||
    (segments.length === 2 && ['channel', 'c', 'user'].includes(segments[0].toLowerCase()));
  if (!isChannelRoot) return u.toString();
  u.pathname = `/${segments.join('/')}/videos`;
  return u.toString();
}

function fmtBytes(bytes) {
  if (!bytes || bytes < 0) return '0 GB';
  if (bytes < 1_000_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

function fmtDuration(seconds) {
  if (!seconds) return '?';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function fmtElapsed(ms) {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m ${total % 60}s`;
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

/**
 * Run `worker` over `items` with at most `concurrency` in flight. Workers pull
 * from a shared cursor, so a slow 40-minute video never blocks the queue behind
 * it the way a fixed chunked split would.
 */
async function runPool(items, concurrency, worker) {
  let cursor = 0;
  const lanes = Math.max(1, Math.min(concurrency, items.length));
  const workers = Array.from({ length: lanes }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  });
  await Promise.all(workers);
}

// Serializes async writes so concurrent downloads can't interleave ledger saves.
function createWriteQueue() {
  let tail = Promise.resolve();
  return (task) => {
    const run = tail.then(task, task);
    tail = run.catch(() => {});
    return run;
  };
}

module.exports = {
  sleep,
  sanitizeTitle,
  isVideoId,
  isYouTubeUrl,
  channelVideosUrl,
  fmtBytes,
  fmtDuration,
  fmtElapsed,
  csvEscape,
  toCsv,
  runPool,
  createWriteQueue,
};
