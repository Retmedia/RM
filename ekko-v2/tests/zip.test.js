const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { ZipBuilder, crc32 } = require('../server/zip');

// CRC-32 reference values from the standard.
test('crc32 — known vectors', () => {
  assert.equal(crc32(Buffer.from('')), 0x00000000);
  assert.equal(crc32(Buffer.from('123456789')), 0xCBF43926);
  assert.equal(crc32(Buffer.from('hello world')), 0x0D4A1185);
});

// Parse the End Of Central Directory record + central directory entries.
function parseZip(buf) {
  // Find EOCD scanning back from the end.
  let eocdOff = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xFFFF); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocdOff = i; break; }
  }
  assert.ok(eocdOff !== -1, 'EOCD not found');
  const totalEntries = buf.readUInt16LE(eocdOff + 10);
  const cdSize = buf.readUInt32LE(eocdOff + 12);
  const cdOffset = buf.readUInt32LE(eocdOff + 16);

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, 'central dir signature');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');

    // Read local header to get the data.
    assert.equal(buf.readUInt32LE(localOff), 0x04034b50, 'local sig');
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const stored = buf.slice(dataStart, dataStart + compressedSize);

    let data;
    if (method === 0) data = stored;
    else if (method === 8) data = zlib.inflateRawSync(stored);
    else throw new Error('unknown method ' + method);

    entries.push({ name, method, crc, uncompressedSize, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { entries, totalEntries, cdSize, cdOffset };
}

test('ZipBuilder — round-trip stored + deflated entries', () => {
  const z = new ZipBuilder();
  z.addDir('root/');
  z.addFile('root/small.txt', 'hello', { compress: false });
  // Highly compressible payload so DEFLATE wins.
  const big = 'abcd'.repeat(2000);
  z.addFile('root/big.txt', big);
  const buf = z.finalize();

  const { entries, totalEntries } = parseZip(buf);
  assert.equal(totalEntries, 3);
  const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
  assert.ok(byName['root/']);
  assert.equal(byName['root/'].uncompressedSize, 0);
  assert.equal(byName['root/small.txt'].data.toString(), 'hello');
  assert.equal(byName['root/big.txt'].data.toString(), big);
});

test('ZipBuilder — UTF-8 filenames preserved', () => {
  const z = new ZipBuilder();
  z.addFile('héllo_wörld.md', 'x');
  const buf = z.finalize();
  const { entries } = parseZip(buf);
  assert.equal(entries[0].name, 'héllo_wörld.md');
});

const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');

function fixtureVtt(text) {
  return [
    'WEBVTT',
    '',
    '00:00:00.000 --> 00:00:02.000',
    text,
    '',
  ].join('\n');
}

async function writeFixtureVault() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ekko-test-'));
  process.env.EKKOARCHIVE_VAULT = root;
  // Wipe require cache so storage picks up the new env var.
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/ekko-v2/server/')) delete require.cache[k];
  }
  const storage = require('../server/storage');
  const channelKey = 'jack-neel-abcd1234';

  await storage.saveChannelMeta(channelKey, {
    id: 'UCabcd1234',
    title: 'Jack Neel',
    uploader: 'Jack Neel',
    description: 'Solo channel',
    url: 'https://www.youtube.com/@jackneel',
    fetched_at: '2024-01-01T00:00:00Z',
  });

  const transcripts = path.join(storage.transcriptDir(channelKey));
  await fs.mkdir(transcripts, { recursive: true });

  const videos = [
    { id: 'aaaaaaaaaaa', title: '#1 Divorce Lawyer Reacts To Bad Advice',
      upload_date: '20240105', body: 'word '.repeat(50).trim() },
    { id: 'bbbbbbbbbbb', title: 'How To Cook Pasta Like A Pro',
      upload_date: '20240120', body: 'word '.repeat(80).trim() },
    { id: 'ccccccccccc', title: 'No Captions Here',
      upload_date: '20240210', body: null },
  ];

  for (const v of videos) {
    let file = null;
    if (v.body) {
      file = `${v.id}.en.vtt`;
      await fs.writeFile(path.join(transcripts, file), fixtureVtt(v.body));
    }
    await storage.saveVideo(channelKey, {
      id: v.id, title: v.title,
      url: `https://www.youtube.com/watch?v=${v.id}`,
      duration: 600, upload_date: v.upload_date,
      view_count: 1000, thumbnail: null, description: null,
      transcript_status: v.body ? 'ok' : 'unavailable',
      transcript_reason: v.body ? null : 'no transcript available',
      transcript_segments: v.body ? 1 : 0,
      transcript_file: file,
      word_count: v.body ? v.body.split(/\s+/).filter(Boolean).length : 0,
      archived_at: '2024-03-01T00:00:00Z',
    });
  }

  return { root, channelKey };
}

test('buildVaultZip — produces correct structure for a 3-video fixture', async () => {
  const { root } = await writeFixtureVault();
  try {
    const { buildVaultZip } = require('../server/export');
    const { buffer, filename } = await buildVaultZip('jack-neel-abcd1234', { individual: true, srt: true });

    // Filename: PascalCase channel + ISO date + .zip
    assert.match(filename, /^JackNeel_EkkoVault_\d{4}-\d{2}-\d{2}\.zip$/);

    const { entries } = parseZip(buffer);
    const names = entries.map((e) => e.name);

    const baseRe = /^JackNeel_EkkoVault_\d{4}-\d{2}-\d{2}\//;
    const base = names.find((n) => baseRe.test(n)).match(baseRe)[0];

    // Required files at root — both .md and .html companions for README and COMBINED_MASTER.
    assert.ok(names.includes(`${base}README.md`), 'README.md missing');
    assert.ok(names.includes(`${base}README.html`), 'README.html missing');
    assert.ok(names.includes(`${base}COMBINED_MASTER.md`), 'COMBINED_MASTER.md missing');
    assert.ok(names.includes(`${base}COMBINED_MASTER.html`), 'COMBINED_MASTER.html missing');
    assert.ok(names.includes(`${base}INDEX.csv`), 'INDEX missing');

    // Individual files, slugified per spec — one .md and one .html per video.
    const indivMd = names.filter((n) => n.startsWith(`${base}individual_transcripts/`) && n.endsWith('.md'));
    const indivHtml = names.filter((n) => n.startsWith(`${base}individual_transcripts/`) && n.endsWith('.html'));
    assert.equal(indivMd.length, 2, 'expected 2 individual .md transcripts (one is unavailable)');
    assert.equal(indivHtml.length, 2, 'expected 2 individual .html transcripts');
    assert.ok(indivMd.some((n) => /aaaaaaaaaaa__1_divorce_lawyer_reacts/.test(n)), 'leading # preserved as _ (md)');
    assert.ok(indivHtml.some((n) => /aaaaaaaaaaa__1_divorce_lawyer_reacts/.test(n)), 'leading # preserved as _ (html)');
    assert.ok(indivMd.some((n) => /bbbbbbbbbbb_how_to_cook_pasta_like_a_pro/.test(n)), 'normal title slug (md)');

    // SRT files only when opted in.
    const srt = names.filter((n) => n.startsWith(`${base}srt_files/`) && n.endsWith('.srt'));
    assert.equal(srt.length, 2, 'expected 2 SRT files');

    // COMBINED_MASTER (md) must start with the required header.
    const masterEntry = entries.find((e) => e.name === `${base}COMBINED_MASTER.md`);
    const master = masterEntry.data.toString('utf8');
    assert.match(master, /^# Jack Neel — Complete Transcript Vault/m);
    assert.match(master, /\*\*Generated:\*\* \w+ \d+, \d{4}/);
    assert.match(master, /\*\*Total Videos:\*\* 2/);
    assert.match(master, /\*\*Total Words:\*\*/);
    assert.match(master, /Search with Ctrl\+F \/ Cmd\+F/);

    // COMBINED_MASTER.html must be a valid-looking standalone document.
    const masterHtmlEntry = entries.find((e) => e.name === `${base}COMBINED_MASTER.html`);
    const masterHtml = masterHtmlEntry.data.toString('utf8');
    assert.match(masterHtml, /^<!doctype html>/i);
    assert.match(masterHtml, /<style>[\s\S]+<\/style>/);  // embedded CSS, no external deps
    assert.match(masterHtml, /Jack Neel.*Complete Transcript Vault/);
    assert.match(masterHtml, /Total Videos<\/dt><dd>2<\/dd>/);
    assert.match(masterHtml, /<details class="toc">/);     // TOC for jumping to videos
    assert.match(masterHtml, /How To Cook Pasta/);          // newer video first
    assert.match(masterHtml, /Divorce Lawyer/);             // older video also present
    // Newest-first ordering also holds in HTML.
    const hIdxA = masterHtml.indexOf('How To Cook Pasta');
    const hIdxB = masterHtml.indexOf('Divorce Lawyer');
    assert.ok(hIdxA > -1 && hIdxB > -1 && hIdxA < hIdxB, 'newer video should come first in HTML');

    // README.html must be a valid standalone document with the same forbidden-claim guarantees.
    const readmeHtmlEntry = entries.find((e) => e.name === `${base}README.html`);
    const readmeHtml = readmeHtmlEntry.data.toString('utf8');
    assert.match(readmeHtml, /^<!doctype html>/i);
    assert.match(readmeHtml, /Ekko Vault/);
    assert.match(readmeHtml, /COMBINED_MASTER\.html/);  // points the user at the html landing
    assert.doesNotMatch(readmeHtml, /Professionally cleaned/i);
    assert.doesNotMatch(readmeHtml, /90.day.+re.archive/i);
    assert.doesNotMatch(readmeHtml, /reply to this delivery email/i);

    // README.md must NOT include the forbidden marketing claims.
    const readmeEntry = entries.find((e) => e.name === `${base}README.md`);
    const readme = readmeEntry.data.toString('utf8');
    assert.doesNotMatch(readme, /Professionally cleaned/i);
    assert.doesNotMatch(readme, /90.day.+re.archive/i);
    assert.doesNotMatch(readme, /reply to this delivery email/i);
    assert.match(readme, /Your content\. Your words\. Owned\./);

    // Sample one individual HTML and confirm it has the video metadata.
    const oneIndivHtmlEntry = entries.find((e) => /aaaaaaaaaaa__1_divorce_lawyer.*\.html$/.test(e.name));
    const oneIndivHtml = oneIndivHtmlEntry.data.toString('utf8');
    assert.match(oneIndivHtml, /^<!doctype html>/i);
    assert.match(oneIndivHtml, /1 Divorce Lawyer/);
    assert.match(oneIndivHtml, /<dt>Channel<\/dt><dd>Jack Neel<\/dd>/);

    // INDEX.csv has the header row + 3 data rows.
    const indexEntry = entries.find((e) => e.name === `${base}INDEX.csv`);
    const csv = indexEntry.data.toString('utf8');
    const csvLines = csv.split(/\r?\n/).filter(Boolean);
    assert.equal(csvLines.length, 4);
    assert.match(csvLines[0], /^"Title","Video URL"/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('buildVaultZip — opting out of individual + srt gives only the 5 root files', async () => {
  const { root } = await writeFixtureVault();
  try {
    const { buildVaultZip } = require('../server/export');
    const { buffer } = await buildVaultZip('jack-neel-abcd1234', { individual: false, srt: false });
    const { entries } = parseZip(buffer);
    const files = entries.filter((e) => !e.name.endsWith('/')).map((e) => e.name);
    // README.md, README.html, COMBINED_MASTER.md, COMBINED_MASTER.html, INDEX.csv
    assert.equal(files.length, 5, files.join('\n'));
    assert.ok(files.some((f) => /README\.html$/.test(f)));
    assert.ok(files.some((f) => /COMBINED_MASTER\.html$/.test(f)));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('renderDeliveryEmail — falls back to "there" when customerName missing', async () => {
  const { renderDeliveryEmail } = require('../server/email');
  const out = await renderDeliveryEmail({
    channelName: 'Jack Neel',
    customerName: '',
    downloadUrl: 'https://example.com/d',
    videoCount: 12,
    wordCount: '120,000',
  });
  assert.match(out.subject, /Your Jack Neel Ekko Vault is ready/);
  assert.match(out.body, /Hi there,/);
  assert.match(out.body, /12 videos archived/);
  assert.match(out.body, /~120,000 words/);
  assert.doesNotMatch(out.body, /\[Name\]/i);
});

test('renderDeliveryEmail — uses provided customer name', async () => {
  const { renderDeliveryEmail } = require('../server/email');
  const out = await renderDeliveryEmail({
    channelName: 'Jack Neel',
    customerName: '  Jamie  ',
    downloadUrl: 'https://example.com/d',
    videoCount: 5,
    wordCount: '8,000',
  });
  assert.match(out.body, /Hi Jamie,/);
});

// ===========================================================================
// Storage CRUD coverage — these test the disk operations directly without
// going through the HTTP layer, so they're fast and deterministic.
// ===========================================================================

test('storage.patchChannelMeta — preserves user fields when totals are recomputed', async () => {
  const { root, channelKey } = await writeFixtureVault();
  try {
    const storage = require('../server/storage');
    // Operator sets a customer name + notes + delivered flag.
    await storage.patchChannelMeta(channelKey, {
      customer_name: 'Jamie Smith',
      notes: 'May launch',
      delivered: true,
      delivered_at: '2026-05-05T00:00:00Z',
    });
    // A subsequent re-pull then writes new totals — must not blow away the
    // operator's fields.
    const after = await storage.recomputeChannelTotals(channelKey);
    assert.equal(after.total_videos, 2);
    const ch = await storage.getChannel(channelKey);
    assert.equal(ch.customer_name, 'Jamie Smith');
    assert.equal(ch.notes, 'May launch');
    assert.equal(ch.delivered, true);
    assert.equal(ch.delivered_at, '2026-05-05T00:00:00Z');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('storage.deleteChannel — refuses path traversal and underscore-prefixed keys', async () => {
  const { root } = await writeFixtureVault();
  try {
    const storage = require('../server/storage');
    await assert.rejects(() => storage.deleteChannel('../etc'), /invalid/);
    await assert.rejects(() => storage.deleteChannel('foo/bar'), /invalid/);
    await assert.rejects(() => storage.deleteChannel('_jobs'), /invalid/);
    await assert.rejects(() => storage.deleteChannel(''), /required/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('storage.getVaultStats — sums rolled-up totals across channels', async () => {
  const { root, channelKey } = await writeFixtureVault();
  try {
    const storage = require('../server/storage');
    await storage.recomputeChannelTotals(channelKey);
    await storage.patchChannelMeta(channelKey, { delivered: true });
    const stats = await storage.getVaultStats();
    assert.equal(stats.channels, 1);
    assert.equal(stats.delivered, 1);
    assert.equal(stats.total_videos, 2);
    assert.ok(stats.total_words > 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('storage.listVideos — distinguishes ok from unavailable for retry-all targeting', async () => {
  const { root, channelKey } = await writeFixtureVault();
  try {
    const storage = require('../server/storage');
    const all = await storage.listVideos(channelKey);
    assert.equal(all.length, 3);
    const failing = all.filter((v) => v.transcript_status !== 'ok');
    assert.equal(failing.length, 1, 'fixture has exactly 1 unavailable video');
    assert.equal(failing[0].id, 'ccccccccccc');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('buildVaultZip — refuses to export a channel with no successful transcripts', async () => {
  const { root, channelKey } = await writeFixtureVault();
  try {
    const storage = require('../server/storage');
    // Wipe every video record so 0 are transcript_status === 'ok'.
    const videos = await storage.listVideos(channelKey);
    for (const v of videos) {
      await storage.saveVideo(channelKey, { ...v, transcript_status: 'unavailable', transcript_file: null });
    }
    const { buildVaultZip } = require('../server/export');
    await assert.rejects(
      () => buildVaultZip(channelKey),
      /no successfully-pulled transcripts/i,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
