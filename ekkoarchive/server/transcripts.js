const { execFile } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs/promises');
const { promisify } = require('node:util');
const { isVideoId } = require('./utils');
const { YT_DLP } = require('./youtube');

const execFileP = promisify(execFile);

async function pullTranscript(videoId, workDir, language = 'en', signal) {
  if (!isVideoId(videoId)) throw new Error('Invalid video id');
  if (signal?.aborted) return { ok: false, reason: 'cancelled' };
  await fs.mkdir(workDir, { recursive: true });

  const outTemplate = path.join(workDir, '%(id)s.%(ext)s');
  const args = [
    '--skip-download',
    '--write-auto-subs',
    '--write-subs',
    '--sub-langs', `${language}.*,${language}`,
    '--sub-format', 'vtt',
    '--no-warnings',
    '-o', outTemplate,
    `https://www.youtube.com/watch?v=${videoId}`,
  ];

  try {
    await execFileP(YT_DLP, args, {
      encoding: 'utf8',
      timeout: 3 * 60 * 1000,
      maxBuffer: 16 * 1024 * 1024,
      signal,
    });
  } catch (e) {
    if (e.name === 'AbortError' || signal?.aborted) return { ok: false, reason: 'cancelled' };
    return { ok: false, reason: (e.stderr || e.message || '').toString().slice(0, 500) };
  }

  const entries = await fs.readdir(workDir);
  const vttFile = entries.find((f) => f.startsWith(videoId) && f.endsWith('.vtt'));
  if (!vttFile) return { ok: false, reason: 'no transcript available' };

  const fullPath = path.join(workDir, vttFile);
  const raw = await fs.readFile(fullPath, 'utf8');
  const segments = parseVTT(raw);

  // Persist a clean, readable plaintext transcript next to the raw VTT so the
  // vault is searchable/usable without re-parsing subtitle markup.
  const text = segments.map((s) => s.text).join('\n');
  const textFile = `${videoId}.txt`;
  await fs.writeFile(path.join(workDir, textFile), text ? `${text}\n` : '');

  return { ok: true, segments, raw, text, file: vttFile, textFile, path: fullPath };
}

function parseVTT(vtt) {
  const lines = vtt.split(/\r?\n/);
  const segments = [];
  let i = 0;
  while (i < lines.length && !/-->/.test(lines[i])) i++;

  while (i < lines.length) {
    const m = lines[i].match(
      /(\d+):(\d+):(\d+)[.,](\d+)\s*-->\s*(\d+):(\d+):(\d+)[.,](\d+)/
    );
    if (!m) { i++; continue; }
    const start = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
    const end   = (+m[5]) * 3600 + (+m[6]) * 60 + (+m[7]) + (+m[8]) / 1000;
    i++;
    const buf = [];
    while (i < lines.length && lines[i].trim() !== '') {
      buf.push(stripVttTags(lines[i]));
      i++;
    }
    while (i < lines.length && lines[i].trim() === '') i++;
    const text = collapseRepeats(buf.join(' ').replace(/\s+/g, ' ').trim());
    if (text) segments.push({ start, end, text });
  }
  return segments;
}

function stripVttTags(line) {
  return line
    .replace(/<\d+:\d+:\d+\.\d+>/g, '')
    .replace(/<\/?[cv][^>]*>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function collapseRepeats(s) {
  return s.replace(/\b(\w+)( \1\b)+/gi, '$1');
}

module.exports = { pullTranscript, parseVTT };
