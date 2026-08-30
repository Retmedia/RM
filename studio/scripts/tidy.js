#!/usr/bin/env node
// Removes media that no post points at any more, and takes a snapshot first so
// the clear-out is itself recoverable.
const store = require('../server/store');

(async function tidy() {
  const unused = await store.unusedMedia();
  if (!unused.length) {
    console.log('Nothing to clear.');
    return;
  }
  const mb = (unused.reduce((n, m) => n + (m.size || 0), 0) / 1048576).toFixed(1);
  await store.snapshot();
  const removed = await store.deleteMedia(unused.map((m) => m.id));
  console.log(`Removed ${removed.length} unused file(s), ${mb}MB.`);
}());
