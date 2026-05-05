const crypto = require('node:crypto');

// PascalCase the channel name for filenames.
//   "Jack Neel"   -> "JackNeel"
//   "@MrBeast"    -> "MrBeast"
//   "한국어 채널"  -> "" -> fall back to second arg
function pascalCaseChannelName(name, fallback = '') {
  const out = String(name || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
  if (out) return out;
  const fb = String(fallback || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .split(/[^A-Za-z0-9]+/).filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
  return fb || 'Channel';
}

// Slug for a single video title used in filenames.
//   "#1 Divorce Lawyer..." -> "_1_divorce_lawyer"
//   Replaces non-alphanumerics with _, collapses repeats, trims to 60.
function slugifyTitle(title) {
  const s = String(title || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const leadingHash = /^#/.test(s);
  let out = s.toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (leadingHash && !out.startsWith('_')) out = '_' + out;
  out = out.slice(0, 60).replace(/_+$/g, '');
  return out || 'untitled';
}

// Disambiguate video filenames when two titles slugify to the same string.
function shortHash(input, len = 6) {
  return crypto.createHash('sha1').update(String(input)).digest('hex').slice(0, len);
}

// Phase 5 word-count rounding.
//   < 10,000           -> exact with commas, "8,432"
//   10,000 – 999,999   -> nearest thousand with commas, "340,000"
//   >= 1,000,000       -> one decimal + "million", "2.1 million"
function formatWordCount(n) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  if (v < 10_000) return v.toLocaleString('en-US');
  if (v < 1_000_000) {
    const k = Math.round(v / 1000) * 1000;
    return k.toLocaleString('en-US');
  }
  const m = v / 1_000_000;
  const fixed = m >= 10 ? m.toFixed(0) : m.toFixed(1);
  return `${fixed} million`;
}

// "May 5, 2026" — locale-stable English short form for headers.
function formatHeaderDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

// "2026-05-05" in the user's local timezone (not UTC).
function localISODate(date) {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Count words in transcript segments (or any text).
function wordCount(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

module.exports = {
  pascalCaseChannelName,
  slugifyTitle,
  shortHash,
  formatWordCount,
  formatHeaderDate,
  localISODate,
  wordCount,
};
