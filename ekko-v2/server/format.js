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
  // toFixed rounds inconsistently for floats like 2.15 (stored as 2.1499...);
  // round to one decimal explicitly so the boundary cases match user intuition.
  const rounded = Math.round(m * 10) / 10;
  const fixed = m >= 10 ? Math.round(m).toString() : rounded.toFixed(1);
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

// Parse text the user pasted from YouTube's "Show transcript" panel. Handles:
//   1) Standalone-timestamp + text-on-next-line ("0:03\nhello and welcome")
//   2) Inline-timestamp ("0:03 hello and welcome")
//   3) Plain text with no timestamps — stored as one big segment
// Returns [{ start, end, text }, …] suitable for synthesising a VTT.
function parsePastedTranscript(text, videoDuration = 999_999) {
  const t = String(text || '').replace(/\r/g, '').trim();
  if (!t) return [];
  const tsRe = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,]\d+)?\s*(.*)$/;
  const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);

  const segs = [];
  let pendingTs = null;
  for (const line of lines) {
    const m = line.match(tsRe);
    if (m) {
      const start = (parseInt(m[1] || '0', 10)) * 3600
                  + parseInt(m[2], 10) * 60
                  + parseInt(m[3], 10);
      const inline = (m[4] || '').trim();
      if (inline) {
        segs.push({ start, end: 0, text: inline });
        pendingTs = null;
      } else {
        pendingTs = start;
      }
    } else if (pendingTs !== null) {
      segs.push({ start: pendingTs, end: 0, text: line });
      pendingTs = null;
    } else if (segs.length === 0) {
      // No timestamps anywhere — treat the whole paste as one segment.
      segs.push({ start: 0, end: videoDuration, text: t.replace(/\s+/g, ' ') });
      return segs;
    } else {
      // Continuation of the previous timestamped segment.
      segs[segs.length - 1].text += ' ' + line;
    }
  }
  if (segs.length === 0) {
    segs.push({ start: 0, end: videoDuration, text: t });
  }
  for (let i = 0; i < segs.length; i++) {
    segs[i].end = i + 1 < segs.length ? segs[i + 1].start : videoDuration;
  }
  return segs;
}

function formatVttTime(secs) {
  const v = Math.max(0, Number(secs) || 0);
  const h = Math.floor(v / 3600);
  const m = Math.floor((v % 3600) / 60);
  const s = Math.floor(v % 60);
  const ms = Math.floor((v - Math.floor(v)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

function segmentsToVtt(segments) {
  const lines = ['WEBVTT', ''];
  for (const s of segments) {
    lines.push(`${formatVttTime(s.start)} --> ${formatVttTime(s.end)}`);
    lines.push(String(s.text || '').replace(/\s+/g, ' ').trim());
    lines.push('');
  }
  return lines.join('\n');
}

module.exports = {
  pascalCaseChannelName,
  slugifyTitle,
  shortHash,
  formatWordCount,
  formatHeaderDate,
  localISODate,
  wordCount,
  parsePastedTranscript,
  segmentsToVtt,
  formatVttTime,
};
