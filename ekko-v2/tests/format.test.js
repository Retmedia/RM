const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  pascalCaseChannelName,
  slugifyTitle,
  formatWordCount,
  localISODate,
  parsePastedTranscript,
  segmentsToVtt,
} = require('../server/format');
const { parseVTT } = require('../server/transcripts');

test('pascalCaseChannelName — typical names', () => {
  assert.equal(pascalCaseChannelName('Jack Neel'), 'JackNeel');
  assert.equal(pascalCaseChannelName('@MrBeast'), 'MrBeast');
  assert.equal(pascalCaseChannelName('all caps news'), 'AllCapsNews');
  assert.equal(pascalCaseChannelName('lex-fridman'), 'LexFridman');
});

test('pascalCaseChannelName — fallback when name has only non-Latin', () => {
  assert.equal(pascalCaseChannelName('한국어 채널', '@kchannel'), 'Kchannel');
  assert.equal(pascalCaseChannelName('日本語'), 'Channel');
  assert.equal(pascalCaseChannelName('', 'fallback name'), 'FallbackName');
});

test('pascalCaseChannelName — emoji and punctuation stripped', () => {
  assert.equal(pascalCaseChannelName('🎙 The Pod!'), 'ThePod');
  assert.equal(pascalCaseChannelName('A & B Show'), 'ABShow');
});

test('slugifyTitle — basic lowercase + underscore separator', () => {
  assert.equal(slugifyTitle('Hello World'), 'hello_world');
  assert.equal(slugifyTitle('How To Cook Pasta'), 'how_to_cook_pasta');
});

test('slugifyTitle — preserves leading # as underscore', () => {
  assert.equal(slugifyTitle('#1 Divorce Lawyer Reacts'), '_1_divorce_lawyer_reacts');
  assert.equal(slugifyTitle('#Tip Of The Day'), '_tip_of_the_day');
});

test('slugifyTitle — collapses repeats and trims edges', () => {
  assert.equal(slugifyTitle('foo  ---  bar'), 'foo_bar');
  assert.equal(slugifyTitle('   leading and trailing   '), 'leading_and_trailing');
});

test('slugifyTitle — non-Latin scripts fall back to underscores', () => {
  assert.equal(slugifyTitle('한국어'), 'untitled');
  assert.equal(slugifyTitle('日本語タイトル'), 'untitled');
  assert.equal(slugifyTitle('한국어 video about cats'), 'video_about_cats');
});

test('slugifyTitle — emoji titles', () => {
  assert.equal(slugifyTitle('🚀🚀🚀'), 'untitled');
  assert.equal(slugifyTitle('🚀 Launch Day'), 'launch_day');
});

test('slugifyTitle — caps preserved as lowercase', () => {
  assert.equal(slugifyTitle('ALL CAPS TITLE'), 'all_caps_title');
});

test('slugifyTitle — trims to 60 chars', () => {
  const long = 'a'.repeat(120);
  const slug = slugifyTitle(long);
  assert.ok(slug.length <= 60, `expected <=60, got ${slug.length}`);
});

test('slugifyTitle — long real-world title with mixed punctuation', () => {
  const t = 'How I Made $1,000,000 In 30 Days (And You Can Too!!!) — A Complete Guide';
  const slug = slugifyTitle(t);
  assert.ok(slug.length <= 60);
  assert.ok(slug.startsWith('how_i_made'));
  assert.ok(!/__+/.test(slug), 'no double underscores');
});

test('slugifyTitle — identical titles slugify identically (caller handles collisions)', () => {
  assert.equal(slugifyTitle('My Video'), slugifyTitle('My Video'));
});

test('formatWordCount — exact under 10k', () => {
  assert.equal(formatWordCount(0), '0');
  assert.equal(formatWordCount(1), '1');
  assert.equal(formatWordCount(8432), '8,432');
  assert.equal(formatWordCount(9999), '9,999');
});

test('formatWordCount — boundary 10,000', () => {
  // 10,000 is rounded to nearest 1000 = 10,000 itself
  assert.equal(formatWordCount(10000), '10,000');
});

test('formatWordCount — nearest thousand 10k–999,999', () => {
  assert.equal(formatWordCount(10499), '10,000');
  assert.equal(formatWordCount(10500), '11,000');
  assert.equal(formatWordCount(340000), '340,000');
  assert.equal(formatWordCount(340432), '340,000');
  assert.equal(formatWordCount(999999), '1,000,000');
  // 999,499 -> rounded to 999,000
  assert.equal(formatWordCount(999499), '999,000');
});

test('formatWordCount — millions with one decimal', () => {
  assert.equal(formatWordCount(1000000), '1.0 million');
  assert.equal(formatWordCount(2100000), '2.1 million');
  assert.equal(formatWordCount(2150000), '2.2 million');
  assert.equal(formatWordCount(10000000), '10 million');
  assert.equal(formatWordCount(12500000), '13 million');
});

test('formatWordCount — invalid inputs', () => {
  assert.equal(formatWordCount(null), '0');
  assert.equal(formatWordCount(undefined), '0');
  assert.equal(formatWordCount(NaN), '0');
  assert.equal(formatWordCount(-50), '0');
});

test('localISODate — uses local timezone components, not UTC', () => {
  // Pass a Date and assert YYYY-MM-DD format. Don't lock to a specific TZ.
  const d = new Date(2024, 0, 15, 12, 0, 0); // Jan 15 2024 noon local
  assert.equal(localISODate(d), '2024-01-15');
});

test('parsePastedTranscript — YouTube standalone-timestamp format', () => {
  const text = `0:00\nhello and welcome\n0:03\ntoday we will talk about beekeeping\n0:09\nbasics for beginners`;
  const segs = parsePastedTranscript(text, 600);
  assert.equal(segs.length, 3);
  assert.equal(segs[0].start, 0); assert.equal(segs[0].text, 'hello and welcome');
  assert.equal(segs[1].start, 3); assert.equal(segs[1].text, 'today we will talk about beekeeping');
  assert.equal(segs[2].start, 9); assert.equal(segs[2].text, 'basics for beginners');
  // Last segment ends at video duration.
  assert.equal(segs[2].end, 600);
  // Earlier segments end where the next begins.
  assert.equal(segs[0].end, 3);
  assert.equal(segs[1].end, 9);
});

test('parsePastedTranscript — inline-timestamp format', () => {
  const text = `0:00 hello and welcome\n0:03 today we will talk about beekeeping`;
  const segs = parsePastedTranscript(text, 60);
  assert.equal(segs.length, 2);
  assert.equal(segs[0].text, 'hello and welcome');
  assert.equal(segs[1].text, 'today we will talk about beekeeping');
});

test('parsePastedTranscript — plain text without timestamps becomes one segment', () => {
  const text = 'hello and welcome today we will talk about beekeeping basics for beginners';
  const segs = parsePastedTranscript(text, 600);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].start, 0);
  assert.equal(segs[0].end, 600);
  assert.match(segs[0].text, /hello and welcome/);
});

test('parsePastedTranscript — empty input', () => {
  assert.deepEqual(parsePastedTranscript('', 600), []);
  assert.deepEqual(parsePastedTranscript('   \n  \n', 600), []);
});

test('parsePastedTranscript — H:MM:SS timestamps for long videos', () => {
  const text = `1:02:03\nhello\n1:02:10\nworld`;
  const segs = parsePastedTranscript(text, 4000);
  assert.equal(segs.length, 2);
  assert.equal(segs[0].start, 1 * 3600 + 2 * 60 + 3);
  assert.equal(segs[1].start, 1 * 3600 + 2 * 60 + 10);
});

test('segmentsToVtt — produces a parseable VTT round-trip', () => {
  const original = [
    { start: 0, end: 3, text: 'hello and welcome' },
    { start: 3, end: 9, text: 'today we will talk about beekeeping' },
  ];
  const vtt = segmentsToVtt(original);
  assert.match(vtt, /^WEBVTT/);
  const reparsed = parseVTT(vtt);
  assert.equal(reparsed.length, 2);
  assert.equal(reparsed[0].text, 'hello and welcome');
  assert.equal(reparsed[1].start, 3);
});

test('segmentsToVtt + parseVTT round-trip via parsePastedTranscript', () => {
  const text = `0:00\nfirst line\n0:05\nsecond line\n0:12\nthird line`;
  const segs = parsePastedTranscript(text, 60);
  const vtt = segmentsToVtt(segs);
  const reparsed = parseVTT(vtt);
  assert.equal(reparsed.length, 3);
  assert.equal(reparsed[0].text, 'first line');
  assert.equal(reparsed[2].start, 12);
});

const { paragraphsFromText } = require('../server/export');

test('paragraphsFromText — chunks long text at sentence boundaries', () => {
  // 5 sentences x 30 words each = 150 words. Default target is 100, so we
  // should get 2 paragraphs (one of ~3 sentences, one of ~2).
  const sentence = 'One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twenty-one twenty-two twenty-three twenty-four twenty-five twenty-six twenty-seven twenty-eight twenty-nine thirty.';
  const text = Array(5).fill(sentence).join(' ');
  const paras = paragraphsFromText(text);
  assert.ok(paras.length >= 2, `expected at least 2 paragraphs, got ${paras.length}`);
  // Every paragraph ends with a sentence terminator.
  for (const p of paras) {
    assert.match(p, /[.!?]\s*$/);
  }
});

test('paragraphsFromText — short text stays as one paragraph', () => {
  const text = 'Just a few words. Not a lot.';
  const paras = paragraphsFromText(text);
  assert.equal(paras.length, 1);
  assert.equal(paras[0], text);
});

test('paragraphsFromText — empty input', () => {
  assert.deepEqual(paragraphsFromText(''), []);
  assert.deepEqual(paragraphsFromText(null), []);
});
