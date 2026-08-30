const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { freshEnv, cleanup, startServer, setupOwner } = require('./helpers');

const dir = freshEnv();
let client;
let creator;
let targets;

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(64, 5)]);
const upload = async (name) => (await client.post('/api/media', PNG, {
  raw: true, headers: { 'content-type': 'image/png', 'x-filename': name },
})).body;

test.before(async () => {
  client = await startServer();
  await setupOwner(client);
  creator = (await client.post('/api/creators', { name: 'Blair', requiresApproval: true })).body;
  const connect = require('../server/connect');
  await connect.connectDemoAccount({
    platform: 'instagram', creatorId: creator.id, username: 'blair', displayName: 'Blair · instagram',
  });
  targets = (await client.get('/api/accounts')).body.map((a) => ({ accountId: a.id }));
});
test.after(async () => { await client.close(); cleanup(dir); });

test('a scheduled post can be moved to a different time', async () => {
  const media = await upload('a.png');
  const post = (await client.post('/api/posts', {
    creatorId: creator.id, caption: 'Move me', mediaIds: [media.id],
    scheduledAt: new Date(Date.now() + 3600_000).toISOString(), status: 'scheduled', targets,
  })).body;

  const later = new Date(Date.now() + 7 * 3600_000).toISOString();
  const moved = (await client.patch(`/api/posts/${post.id}`, { scheduledAt: later })).body;
  assert.equal(moved.scheduledAt, later);
  assert.equal(moved.status, 'scheduled', 'moving it does not knock it out of the queue');
});

test('rewording an approved post withdraws the approval', async () => {
  const media = await upload('b.png');
  const post = (await client.post('/api/posts', {
    creatorId: creator.id, caption: 'Original wording', mediaIds: [media.id],
    scheduledAt: new Date(Date.now() + 3600_000).toISOString(), status: 'scheduled', targets,
  })).body;

  const asClient = await startServer();
  await asClient.post(`/api/review/${post.approval.token}`, { decision: 'approved', name: 'Blair' });
  await asClient.close();

  let current = (await client.get('/api/posts')).body.find((p) => p.id === post.id);
  assert.equal(current.approval.status, 'approved');

  // Changing the words after a yes means the yes no longer covers what goes out.
  const edited = (await client.patch(`/api/posts/${post.id}`, { caption: 'Completely different' })).body;
  assert.equal(edited.approvalReset, true);
  assert.equal(edited.approval.status, 'pending');
  assert.notEqual(edited.approval.token, post.approval.token, 'and the old link is dead');

  const { publishPost } = require('../server/publisher');
  const attempted = await publishPost(post.id);
  assert.equal(attempted.status, 'awaiting_approval', 'it cannot go out on the withdrawn approval');
});

test('only moving the time leaves an approval standing', async () => {
  const media = await upload('c.png');
  const post = (await client.post('/api/posts', {
    creatorId: creator.id, caption: 'Same words', mediaIds: [media.id],
    scheduledAt: new Date(Date.now() + 3600_000).toISOString(), status: 'scheduled', targets,
  })).body;

  const asClient = await startServer();
  await asClient.post(`/api/review/${post.approval.token}`, { decision: 'approved', name: 'Blair' });
  await asClient.close();

  const moved = (await client.patch(`/api/posts/${post.id}`, {
    scheduledAt: new Date(Date.now() + 9 * 3600_000).toISOString(),
  })).body;
  assert.ok(!moved.approvalReset, 'a client does not need to re-approve a time change');
  assert.equal(moved.approval.status, 'approved');
});

test('unused media is found and cleared, and files a post still needs are kept', async () => {
  const store = require('../server/store');
  const orphan = await upload('orphan.png');
  const used = await upload('used.png');
  await client.post('/api/posts', {
    creatorId: creator.id, caption: 'Holds a file', mediaIds: [used.id], status: 'draft', targets,
  });

  const unused = (await client.get('/api/media/unused')).body;
  const ids = unused.items.map((m) => m.id);
  assert.ok(ids.includes(orphan.id), 'the orphan is found');
  assert.ok(!ids.includes(used.id), 'a referenced file is never offered up');
  assert.ok(unused.bytes > 0, 'it reports how much space that is');

  const before = fs.readdirSync(store.MEDIA_DIR).length;
  const { removed } = (await client.post('/api/media/tidy')).body;
  assert.ok(removed >= 1);
  assert.ok(fs.readdirSync(store.MEDIA_DIR).length < before, 'files really left the disk');

  const stillThere = (await client.get('/api/media')).body.map((m) => m.id);
  assert.ok(stillThere.includes(used.id), 'the file a post depends on survived');
});

test('a manager cannot run the tidy-up', async () => {
  await client.post('/api/users', {
    name: 'Olivia', email: 'olivia@example.com', role: 'manager', password: 'postingdesk1',
  });
  const manager = await startServer();
  await manager.post('/api/session', { email: 'olivia@example.com', password: 'postingdesk1' });
  assert.equal((await manager.post('/api/media/tidy')).status, 403);
  await manager.close();
});
