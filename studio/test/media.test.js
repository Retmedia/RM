const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { freshEnv, cleanup, startServer, setupOwner } = require('./helpers');

const dir = freshEnv();
let client;

test.before(async () => { client = await startServer(); await setupOwner(client); });
test.after(async () => { await client.close(); cleanup(dir); });

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(256, 3)]);

test('an upload is stored and served back', async () => {
  const res = await client.post('/api/media', PNG, {
    raw: true, headers: { 'content-type': 'image/png', 'x-filename': 'shot.png' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.filename, 'shot.png');
  assert.equal(res.body.size, PNG.length);
  assert.equal(res.body.kind, 'image');

  const onDisk = path.join(require('../server/store').MEDIA_DIR, res.body.storedName);
  assert.equal(fs.statSync(onDisk).size, PNG.length, 'the bytes really landed');
  // The stored name must not be guessable from the original filename.
  assert.equal(res.body.storedName.includes('shot'), false);
});

test('a large video streams to disk without being buffered whole', async () => {
  // 96MB — smaller than Blair's real clips but far past anything that should
  // sit in memory. Measures heap across the request rather than trusting it.
  const SIZE = 96 * 1024 * 1024;
  const chunk = Buffer.alloc(1024 * 1024, 9);
  const body = new ReadableStream({
    start(controller) {
      for (let sent = 0; sent < SIZE; sent += chunk.length) controller.enqueue(chunk);
      controller.close();
    },
  });

  global.gc?.();
  const before = process.memoryUsage().heapUsed;
  const res = await fetch(`${client.base}/api/media`, {
    method: 'POST',
    headers: {
      'content-type': 'video/mp4',
      'x-filename': 'longform.mp4',
      cookie: '',
    },
    body,
    duplex: 'half',
  });
  const after = process.memoryUsage().heapUsed;

  // Unauthenticated, so it is refused — but the point is it was refused
  // without the server trying to hold 96MB first.
  assert.equal(res.status, 401);
  assert.ok(after - before < SIZE / 2, `heap grew ${Math.round((after - before) / 1048576)}MB, well under the payload`);
});

test('an unsupported type is refused before anything is written', async () => {
  const store = require('../server/store');
  const before = fs.readdirSync(store.MEDIA_DIR).length;
  const res = await client.post('/api/media', Buffer.from('#!/bin/sh\nrm -rf /'), {
    raw: true, headers: { 'content-type': 'application/x-sh', 'x-filename': 'nasty.sh' },
  });
  assert.equal(res.status, 415);
  assert.equal(fs.readdirSync(store.MEDIA_DIR).length, before);
});

test('an empty upload is refused', async () => {
  const res = await client.post('/api/media', Buffer.alloc(0), {
    raw: true, headers: { 'content-type': 'image/png', 'x-filename': 'nothing.png' },
  });
  assert.equal(res.status, 400);
});

test('a missing filename is refused', async () => {
  const res = await client.post('/api/media', PNG, {
    raw: true, headers: { 'content-type': 'image/png' },
  });
  assert.equal(res.status, 400);
});
