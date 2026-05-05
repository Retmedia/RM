const path = require('node:path');
const fs = require('node:fs/promises');
const storage = require('./storage');
const { ZipBuilder } = require('./zip');
const { parseVTT } = require('./transcripts');
const {
  pascalCaseChannelName,
  slugifyTitle,
  shortHash,
  formatWordCount,
  formatHeaderDate,
  localISODate,
  wordCount,
} = require('./format');

// Convert parsed VTT segments to a clean plain-text body.
function segmentsToPlain(segments) {
  return segments.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim();
}

// VTT → SRT (preserves segment timing).
function vttToSrt(vtt) {
  if (!vtt) return null;
  const segs = parseVTT(vtt);
  if (!segs.length) return null;
  const lines = [];
  segs.forEach((s, i) => {
    lines.push(String(i + 1));
    lines.push(`${srtTime(s.start)} --> ${srtTime(s.end)}`);
    lines.push(s.text);
    lines.push('');
  });
  return lines.join('\n');
}
function srtTime(secs) {
  const t = Math.max(0, Math.floor(secs * 1000));
  const ms = t % 1000;
  const total = Math.floor(t / 1000);
  const s = total % 60;
  const m = Math.floor((total / 60) % 60);
  const h = Math.floor(total / 3600);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

// CSV cell with mandatory quoting. Excel-friendly (CRLF line endings).
function csvCell(v) {
  const s = v == null ? '' : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

// Resolve unique slugified filenames within an export.
function uniqueFilename(seen, slug, fallbackKey, ext) {
  const base = slug || 'untitled';
  if (!seen.has(`${base}${ext}`)) {
    seen.add(`${base}${ext}`);
    return `${base}${ext}`;
  }
  const collided = `${base}_${shortHash(fallbackKey)}${ext}`;
  seen.add(collided);
  return collided;
}

// Loads videos + their plain-text transcripts ordered newest-first.
async function loadVideosForExport(channelKey) {
  const videos = await storage.listVideos(channelKey); // already newest-first
  const items = [];
  for (const v of videos) {
    if (v.transcript_status !== 'ok') {
      items.push({ video: v, text: '', segments: [], vtt: null });
      continue;
    }
    const vtt = await storage.readTranscriptVtt(channelKey, v.id);
    const segments = vtt ? parseVTT(vtt) : [];
    items.push({ video: v, text: segmentsToPlain(segments), segments, vtt });
  }
  return items;
}

function buildCombinedMaster(channel, items) {
  const totalWords = items.reduce((sum, x) => sum + wordCount(x.text), 0);
  const generated = formatHeaderDate(new Date());
  const okItems = items.filter((x) => x.text);
  const header = [
    `# ${channel.title || channel.key} — Complete Transcript Vault`,
    `**Generated:** ${generated}`,
    `**Total Videos:** ${okItems.length}`,
    `**Total Words:** ~${formatWordCount(totalWords)}`,
    '',
    'All transcripts are in chronological order (newest to oldest).',
    'Search with Ctrl+F / Cmd+F to find any topic instantly.',
    '',
    '---',
    '',
  ].join('\n');

  const sections = okItems.map((x) => {
    const v = x.video;
    const date = v.upload_date ? formatHeaderDate(toDate(v.upload_date)) : '';
    return [
      `## ${v.title || v.id}`,
      `*${date}*  •  [Watch on YouTube](${v.url})`,
      '',
      x.text,
      '',
      '---',
      '',
    ].join('\n');
  });

  return header + sections.join('\n');
}

function toDate(yyyymmdd) {
  const s = String(yyyymmdd);
  if (/^\d{8}$/.test(s)) {
    return new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00Z`);
  }
  return new Date(s);
}

function buildReadme(channel, items, generated) {
  const okItems = items.filter((x) => x.text);
  const totalWords = items.reduce((sum, x) => sum + wordCount(x.text), 0);
  const lines = [
    '# Ekko Vault – Your Complete YouTube Transcript Archive',
    '',
    `**Channel:** ${channel.title || channel.key}`,
    `**Generated:** ${formatHeaderDate(generated)}`,
    `**Total Videos:** ${okItems.length}`,
    `**Total Words:** ~${formatWordCount(totalWords)}`,
    '',
    '---',
    '',
    '### What You Received',
    '',
    "Every word from this channel's long-form video catalog, archived as searchable text. Yours to keep, regardless of what happens to the original videos.",
    '',
    '### Files Included',
    '',
    '- **COMBINED_MASTER.md** — start here. Every transcript in one searchable file.',
    '- **individual_transcripts/** — one Markdown file per video.',
    '- **INDEX.csv** — titles, URLs, views, dates, word counts.',
    '- **srt_files/** — subtitle files for video editing. (only if present)',
    '',
    '### How to Use It',
    '',
    '- **Search:** open COMBINED_MASTER.md, hit Ctrl+F (or Cmd+F on Mac).',
    '- **Feed an AI:** paste sections — or the whole master file — into Claude, ChatGPT, or any LLM to draft threads, scripts, newsletters, or chapters.',
    '- **Repurpose:** mine old interviews for Shorts, posts, or course material.',
    '- **Archive:** keep a copy somewhere safe. This is your IP.',
    '',
    '---',
    '',
    'Your content. Your words. Owned.',
    '',
  ];
  return lines.join('\n');
}

function buildIndexCsv(items) {
  const header = ['Title', 'Video URL', 'Upload Date', 'Duration (s)', 'View Count', 'Word Count', 'Transcript Status'];
  const rows = [header.map(csvCell).join(',')];
  for (const x of items) {
    const v = x.video;
    rows.push([
      csvCell(v.title || ''),
      csvCell(v.url || ''),
      csvCell(v.upload_date || ''),
      csvCell(v.duration ?? ''),
      csvCell(v.view_count ?? ''),
      csvCell(wordCount(x.text)),
      csvCell(v.transcript_status || ''),
    ].join(','));
  }
  return rows.join('\r\n') + '\r\n';
}

function buildIndividualMd(channel, x) {
  const v = x.video;
  const date = v.upload_date ? formatHeaderDate(toDate(v.upload_date)) : '';
  const lines = [
    `# ${v.title || v.id}`,
    '',
    `**Channel:** ${channel.title || channel.key}`,
    date ? `**Uploaded:** ${date}` : null,
    `**URL:** ${v.url}`,
    `**Word Count:** ${formatWordCount(wordCount(x.text))}`,
    '',
    '---',
    '',
    x.text || '*(no transcript available)*',
    '',
  ].filter((l) => l !== null);
  return lines.join('\n');
}

async function buildVaultZip(channelKey, opts = {}) {
  const includeIndividual = opts.individual !== false;
  const includeSrt = !!opts.srt;
  const channel = await storage.getChannel(channelKey);
  if (!channel) throw new Error('Channel not found');

  const items = await loadVideosForExport(channelKey);
  const generated = new Date();
  const dateStr = localISODate(generated);
  const channelSlug = pascalCaseChannelName(channel.title, channel.uploader || channel.key);
  const zipBaseName = `${channelSlug}_EkkoVault_${dateStr}`;

  const zip = new ZipBuilder();
  const root = `${zipBaseName}/`;
  zip.addDir(root);

  zip.addFile(`${root}README.md`, buildReadme(channel, items, generated));
  zip.addFile(`${root}COMBINED_MASTER.md`, buildCombinedMaster(channel, items));
  zip.addFile(`${root}INDEX.csv`, buildIndexCsv(items));

  if (includeIndividual) {
    zip.addDir(`${root}individual_transcripts/`);
    const seen = new Set();
    for (const x of items) {
      if (!x.text) continue;
      const slug = slugifyTitle(x.video.title || x.video.id);
      const filename = uniqueFilename(seen, `${x.video.id}_${slug}`, x.video.id, '.md');
      zip.addFile(`${root}individual_transcripts/${filename}`, buildIndividualMd(channel, x));
    }
  }

  if (includeSrt) {
    let added = 0;
    const seen = new Set();
    for (const x of items) {
      if (!x.vtt) continue;
      const srt = vttToSrt(x.vtt);
      if (!srt) continue;
      if (added === 0) zip.addDir(`${root}srt_files/`);
      added++;
      const slug = slugifyTitle(x.video.title || x.video.id);
      const filename = uniqueFilename(seen, `${x.video.id}_${slug}`, x.video.id, '.srt');
      zip.addFile(`${root}srt_files/${filename}`, srt);
    }
  }

  const buffer = zip.finalize();
  return { buffer, filename: `${zipBaseName}.zip`, channel, totalVideos: items.filter((x) => x.text).length };
}

module.exports = {
  buildVaultZip,
  buildCombinedMaster,
  buildReadme,
  buildIndexCsv,
  buildIndividualMd,
  vttToSrt,
};
