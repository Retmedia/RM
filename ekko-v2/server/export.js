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
    '- **COMBINED_MASTER.html** — start here. Every transcript in one searchable, browser-readable file. Double-click to open in your browser.',
    '- **COMBINED_MASTER.md** — the same content as Markdown, ready to paste into Claude, ChatGPT, or any LLM.',
    '- **individual_transcripts/** — one file per video. Both `.html` (browser) and `.md` (AI) are provided.',
    '- **INDEX.csv** — titles, URLs, views, dates, word counts.',
    '- **srt_files/** — subtitle files for video editing. (only if present)',
    '',
    '### How to Use It',
    '',
    '- **Read & search:** open COMBINED_MASTER.html, hit Ctrl+F (or Cmd+F on Mac).',
    '- **Feed an AI:** paste sections — or the whole `.md` master — into Claude, ChatGPT, or any LLM to draft threads, scripts, newsletters, or chapters.',
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

// ===========================================================================
// HTML deliverable — same content, browser-readable. The customer can
// double-click any .html file and get a clean, styled, searchable view in
// their default browser without needing to install anything (TextEdit /
// Notepad would otherwise show raw markdown). The .md files stay alongside
// for AI tools and developers.
// ===========================================================================

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Break a long transcript blob into readable paragraphs at sentence boundaries
// — every ~100 words. yt-dlp gives us no paragraph hints, so without this the
// HTML would render as one giant unreadable block.
function paragraphsFromText(text, targetWords = 100) {
  if (!text) return [];
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (!sentences.length) return [text];
  const paras = [];
  let buf = [];
  let count = 0;
  for (const s of sentences) {
    buf.push(s);
    count += s.split(/\s+/).filter(Boolean).length;
    if (count >= targetWords) { paras.push(buf.join(' ')); buf = []; count = 0; }
  }
  if (buf.length) paras.push(buf.join(' '));
  return paras;
}

function paragraphsHtml(text) {
  return paragraphsFromText(text)
    .map((p) => `<p>${escHtml(p)}</p>`)
    .join('\n');
}

const HTML_STYLE = `
:root {
  color-scheme: dark light;
  --bg: #0b0a14;
  --bg-2: #14122160;
  --fg: #ece9f7;
  --fg-dim: #b9b4d6;
  --muted: #8780a8;
  --accent: #a78bfa;
  --line: #2a2647;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #fafafa;
    --bg-2: #ece9f7;
    --fg: #1a1530;
    --fg-dim: #4a4068;
    --muted: #6a6486;
    --accent: #6d3aff;
    --line: #e0dcec;
  }
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0;
  font: 16px/1.7 -apple-system, BlinkMacSystemFont, "Inter", Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  background: var(--bg);
  color: var(--fg);
}
main { max-width: 720px; margin: 0 auto; padding: 3rem 1.25rem 6rem; }
.vault-header, .single-header {
  border-bottom: 1px solid var(--line);
  padding-bottom: 1.5rem;
  margin-bottom: 2rem;
}
h1 { font-size: 1.75rem; font-weight: 700; letter-spacing: -0.01em; margin: 0 0 0.4rem; line-height: 1.25; }
h2 { font-size: 1.2rem; font-weight: 600; margin: 2.5rem 0 0.6rem; letter-spacing: -0.005em; }
.subtitle { color: var(--fg-dim); font-size: 1rem; margin: 0 0 1rem; }
dl.meta { display: grid; grid-template-columns: max-content 1fr; gap: 0.2rem 1rem; margin: 0.6rem 0 0; font-size: 0.88rem; }
dl.meta dt { color: var(--muted); text-transform: uppercase; font-size: 0.7rem; letter-spacing: 0.06em; align-self: center; }
dl.meta dd { margin: 0; color: var(--fg); }
.intro { color: var(--fg-dim); font-size: 0.95rem; margin: 1rem 0 0; }
section.transcript { margin-top: 3rem; padding-top: 2rem; border-top: 1px solid var(--line); }
section.transcript:first-of-type { border-top: 0; padding-top: 0; }
.transcript h2 { margin-top: 0; }
.transcript .meta { color: var(--muted); font-size: 0.85rem; margin: 0.2rem 0 1.5rem; }
.transcript .meta time { color: var(--fg-dim); }
.text p { margin: 0 0 1.1rem; }
.text p:last-child { margin-bottom: 0; }
a { color: var(--accent); text-decoration: none; border-bottom: 1px dotted transparent; }
a:hover { border-bottom-color: var(--accent); }
kbd { font: 0.85em ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--bg-2); border: 1px solid var(--line); border-radius: 4px; padding: 0.05em 0.4em; }
hr { border: 0; border-top: 1px solid var(--line); margin: 2.5rem 0; }
ul, ol { padding-left: 1.4rem; }
li { margin: 0.25rem 0; }
details.toc { margin: 1.5rem 0 0; padding: 0.7rem 1rem; background: var(--bg-2); border: 1px solid var(--line); border-radius: 8px; }
details.toc summary { cursor: pointer; font-weight: 500; color: var(--fg-dim); }
details.toc[open] summary { margin-bottom: 0.5rem; }
details.toc ol { margin: 0; font-size: 0.9rem; max-height: 360px; overflow-y: auto; }
.footer { text-align: center; color: var(--muted); font-style: italic; margin: 3rem 0 0; }
@media print {
  body { background: white; color: black; }
  details.toc { display: none; }
  a { color: black; }
}
`;

function htmlShell({ title, body }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(title)}</title>
<style>${HTML_STYLE}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

function buildCombinedMasterHtml(channel, items) {
  const okItems = items.filter((x) => x.text);
  const totalWords = items.reduce((sum, x) => sum + wordCount(x.text), 0);
  const generated = formatHeaderDate(new Date());
  const channelTitle = channel.title || channel.key;
  const title = `${channelTitle} — Complete Transcript Vault`;

  const toc = okItems.map((x, i) => {
    return `<li><a href="#v${i}">${escHtml(x.video.title || x.video.id)}</a></li>`;
  }).join('\n');

  const sections = okItems.map((x, i) => {
    const v = x.video;
    const date = v.upload_date ? formatHeaderDate(toDate(v.upload_date)) : '';
    const metaBits = [];
    if (date) metaBits.push(`<time>${escHtml(date)}</time>`);
    if (v.url) metaBits.push(`<a href="${escHtml(v.url)}" target="_blank" rel="noopener">Watch on YouTube ↗</a>`);
    return [
      `<section id="v${i}" class="transcript">`,
      `  <h2>${escHtml(v.title || v.id)}</h2>`,
      `  <div class="meta">${metaBits.join('  ·  ')}</div>`,
      `  <div class="text">${paragraphsHtml(x.text)}</div>`,
      `</section>`,
    ].join('\n');
  }).join('\n');

  const body = `
<main>
  <header class="vault-header">
    <h1>${escHtml(channelTitle)} — Complete Transcript Vault</h1>
    <dl class="meta">
      <dt>Generated</dt><dd>${escHtml(generated)}</dd>
      <dt>Total Videos</dt><dd>${okItems.length}</dd>
      <dt>Total Words</dt><dd>~${escHtml(formatWordCount(totalWords))}</dd>
    </dl>
    <p class="intro">All transcripts are in chronological order (newest to oldest). Search this page with <kbd>Ctrl</kbd>+<kbd>F</kbd> / <kbd>Cmd</kbd>+<kbd>F</kbd> to find any topic instantly.</p>
    <details class="toc">
      <summary>Jump to a video (${okItems.length})</summary>
      <ol>${toc}</ol>
    </details>
  </header>
${sections}
</main>
`;
  return htmlShell({ title, body });
}

function buildIndividualHtml(channel, x) {
  const v = x.video;
  const date = v.upload_date ? formatHeaderDate(toDate(v.upload_date)) : '';
  const title = v.title || v.id;
  const channelTitle = channel.title || channel.key;
  const body = `
<main>
  <header class="single-header">
    <h1>${escHtml(title)}</h1>
    <dl class="meta">
      <dt>Channel</dt><dd>${escHtml(channelTitle)}</dd>
      ${date ? `<dt>Uploaded</dt><dd>${escHtml(date)}</dd>` : ''}
      ${v.url ? `<dt>URL</dt><dd><a href="${escHtml(v.url)}" target="_blank" rel="noopener">${escHtml(v.url)}</a></dd>` : ''}
      <dt>Word Count</dt><dd>${escHtml(formatWordCount(wordCount(x.text)))}</dd>
    </dl>
  </header>
  <article class="text">${x.text ? paragraphsHtml(x.text) : '<p><em>(no transcript available)</em></p>'}</article>
</main>
`;
  return htmlShell({ title, body });
}

function buildReadmeHtml(channel, items, generated) {
  const okItems = items.filter((x) => x.text);
  const totalWords = items.reduce((sum, x) => sum + wordCount(x.text), 0);
  const channelTitle = channel.title || channel.key;
  const title = `Ekko Vault — ${channelTitle}`;
  const body = `
<main>
  <header class="vault-header">
    <h1>Ekko Vault</h1>
    <p class="subtitle">Your Complete YouTube Transcript Archive</p>
    <dl class="meta">
      <dt>Channel</dt><dd>${escHtml(channelTitle)}</dd>
      <dt>Generated</dt><dd>${escHtml(formatHeaderDate(generated))}</dd>
      <dt>Total Videos</dt><dd>${okItems.length}</dd>
      <dt>Total Words</dt><dd>~${escHtml(formatWordCount(totalWords))}</dd>
    </dl>
  </header>

  <section>
    <h2>What you received</h2>
    <p>Every word from this channel's long-form video catalog, archived as searchable text. Yours to keep, regardless of what happens to the original videos.</p>
  </section>

  <section>
    <h2>Files</h2>
    <ul>
      <li><strong>COMBINED_MASTER.html</strong> — start here. Every transcript in one searchable, browser-readable file.</li>
      <li><strong>COMBINED_MASTER.md</strong> — the same content as Markdown, ready to paste into AI tools.</li>
      <li><strong>individual_transcripts/</strong> — one file per video. Both <code>.html</code> (read in browser) and <code>.md</code> (paste into AI) are provided.</li>
      <li><strong>INDEX.csv</strong> — titles, URLs, dates, view counts, word counts. Opens in Excel, Numbers, or Google Sheets.</li>
      <li><strong>srt_files/</strong> — subtitle files for video editing. <em>(only present if exported)</em></li>
    </ul>
  </section>

  <section>
    <h2>How to use it</h2>
    <ul>
      <li><strong>Read & search:</strong> open <code>COMBINED_MASTER.html</code> in your browser, hit <kbd>Ctrl</kbd>+<kbd>F</kbd> (or <kbd>Cmd</kbd>+<kbd>F</kbd> on Mac).</li>
      <li><strong>Feed an AI:</strong> paste sections — or the whole <code>.md</code> master — into Claude, ChatGPT, or any LLM to draft threads, scripts, newsletters, or chapters.</li>
      <li><strong>Repurpose:</strong> mine old interviews for Shorts, posts, or course material.</li>
      <li><strong>Archive:</strong> keep a copy somewhere safe. This is your IP.</li>
    </ul>
  </section>

  <hr>
  <p class="footer">Your content. Your words. Owned.</p>
</main>
`;
  return htmlShell({ title, body });
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
  zip.addFile(`${root}README.html`, buildReadmeHtml(channel, items, generated));
  zip.addFile(`${root}COMBINED_MASTER.md`, buildCombinedMaster(channel, items));
  zip.addFile(`${root}COMBINED_MASTER.html`, buildCombinedMasterHtml(channel, items));
  zip.addFile(`${root}INDEX.csv`, buildIndexCsv(items));

  if (includeIndividual) {
    zip.addDir(`${root}individual_transcripts/`);
    const seenMd = new Set();
    const seenHtml = new Set();
    for (const x of items) {
      if (!x.text) continue;
      const slug = slugifyTitle(x.video.title || x.video.id);
      const mdName = uniqueFilename(seenMd, `${x.video.id}_${slug}`, x.video.id, '.md');
      const htmlName = uniqueFilename(seenHtml, `${x.video.id}_${slug}`, x.video.id, '.html');
      zip.addFile(`${root}individual_transcripts/${mdName}`, buildIndividualMd(channel, x));
      zip.addFile(`${root}individual_transcripts/${htmlName}`, buildIndividualHtml(channel, x));
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
  buildCombinedMasterHtml,
  buildReadme,
  buildReadmeHtml,
  buildIndexCsv,
  buildIndividualMd,
  buildIndividualHtml,
  paragraphsFromText,
  vttToSrt,
};
