const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { freshEnv, cleanup } = require('./helpers');

const dir = freshEnv();
process.env.STUDIO_BACKUP_EVERY_MS = '0';
process.env.STUDIO_KEEP_BACKUPS = '3';

test.after(() => {
  delete process.env.STUDIO_BACKUP_EVERY_MS;
  delete process.env.STUDIO_KEEP_BACKUPS;
  cleanup(dir);
});

test('writes leave rotating snapshots behind, capped', async () => {
  const store = require('../server/store');
  for (let i = 0; i < 6; i += 1) {
    await store.createCreator({ name: `Creator ${i}` });
    // Snapshot names are second-resolution, so space them enough to be distinct.
    await new Promise((r) => setTimeout(r, 1100));
  }
  const backups = await store.listBackups();
  assert.ok(backups.length > 1, 'snapshots are being taken');
  assert.ok(backups.length <= 3, `kept ${backups.length}; the cap is 3`);
  assert.ok(backups[0].at >= backups[backups.length - 1].at, 'newest first');
});

test('a corrupted live file is recovered from the newest good snapshot', async () => {
  const store = require('../server/store');
  const before = (await store.listCreators()).length;
  assert.ok(before > 0);
  await store.snapshot();

  // Truncate the live file the way a bad disk or a killed write would.
  const dbFile = path.join(store.DATA_ROOT, 'studio.json');
  fs.writeFileSync(dbFile, '{"creators": [{"id": "cre_1", "na');

  // Force a cold load.
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}server${path.sep}`)) delete require.cache[key];
  }
  const reloaded = require('../server/store');
  const after = await reloaded.listCreators();

  assert.equal(after.length, before, 'every creator came back');
  assert.ok(
    fs.readdirSync(store.DATA_ROOT).some((f) => f.includes('.corrupt-')),
    'the damaged file is kept for inspection rather than overwritten',
  );
});

test('it refuses to start empty when the file is broken and nothing can be restored', async () => {
  const emptyDir = freshEnv();
  const store = require('../server/store');
  fs.writeFileSync(path.join(store.DATA_ROOT, 'studio.json'), 'not json at all');

  await assert.rejects(
    () => store.load(),
    /Refusing to start with an empty studio/,
    'an empty studio must never be presented as a working one',
  );
  cleanup(emptyDir);
});

test('junk that parses but is not studio data is rejected', async () => {
  const store = require('../server/store');
  assert.equal(store.looksLikeStudioData({ creators: [], posts: [] }), true);
  assert.equal(store.looksLikeStudioData({ creators: 'nope' }), false);
  assert.equal(store.looksLikeStudioData('a string'), false);
  assert.equal(store.looksLikeStudioData(null), false);
});
