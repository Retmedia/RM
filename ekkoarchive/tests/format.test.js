const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  pascalCaseChannelName,
  slugifyTitle,
  formatWordCount,
  localISODate,
} = require('../server/format');

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
