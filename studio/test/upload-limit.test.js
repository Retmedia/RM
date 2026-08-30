const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { freshEnv, cleanup, startServer, setupOwner } = require('./helpers');

// Own file: the cap is read once when the server module loads, so it has to be
// set before anything requires it.
const dir = freshEnv();
process.env.STUDIO_MAX_UPLOAD_MB = '1';

let client;
test.before(async () => { client = await startServer(); await setupOwner(client); });
test.after(async () => {
  await client.close();
  delete process.env.STUDIO_MAX_UPLOAD_MB;
  cleanup(dir);
});

test('a file over the cap is cut off mid-stream and leaves nothing behind', async () => {
  const store = require('../server/store');
  const before = fs.readdirSync(store.MEDIA_DIR).length;

  // Two megabytes against a one megabyte cap. The server has to notice while
  // the bytes are arriving, not after holding them all.
  const oversized = Buffer.alloc(2 * 1024 * 1024, 4);
  const res = await client.post('/api/media', oversized, {
    raw: true, headers: { 'content-type': 'video/mp4', 'x-filename': 'too-big.mp4' },
  });

  assert.equal(res.status, 413);
  assert.match(res.body.error, /larger than the 1MB limit/);
  assert.equal(fs.readdirSync(store.MEDIA_DIR).length, before, 'no partial file survives');
});

test('a file just under the cap still goes through', async () => {
  const ok = Buffer.alloc(512 * 1024, 2);
  const res = await client.post('/api/media', ok, {
    raw: true, headers: { 'content-type': 'video/mp4', 'x-filename': 'fine.mp4' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.size, ok.length);
});
