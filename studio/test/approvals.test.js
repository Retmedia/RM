const test = require('node:test');
const assert = require('node:assert/strict');
const { freshEnv, cleanup, startServer, setupOwner } = require('./helpers');

const dir = freshEnv();
let client;
let creator;
let targets;
let mediaId;

test.before(async () => {
  client = await startServer();
  await setupOwner(client);
  creator = (await client.post('/api/creators', { name: 'Blair Conklin', requiresApproval: true })).body;

  const connect = require('../server/connect');
  await connect.connectDemoAccount({
    platform: 'instagram', creatorId: creator.id, username: 'blair', displayName: 'Blair · instagram',
  });
  targets = (await client.get('/api/accounts')).body.map((a) => ({ accountId: a.id }));

  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(64, 1)]);
  mediaId = (await client.post('/api/media', png, {
    raw: true, headers: { 'content-type': 'image/png', 'x-filename': 'a.png' },
  })).body.id;
});

test.after(async () => { await client.close(); cleanup(dir); });

async function newPost(caption = 'For review') {
  return (await client.post('/api/posts', {
    creatorId: creator.id, caption, mediaIds: [mediaId], status: 'draft', targets,
  })).body;
}

test('a creator marked for approval mints a review token on every post', async () => {
  const post = await newPost();
  assert.equal(post.approval.required, true);
  assert.equal(post.approval.status, 'pending');
  assert.ok(post.approval.token);
});

test('nothing unapproved publishes, even when told to force it', async () => {
  const post = await newPost();
  const res = await client.post(`/api/posts/${post.id}/publish`, { force: true });
  assert.equal(res.body.status, 'awaiting_approval');
  for (const target of res.body.targets) {
    assert.notEqual(target.status, 'published');
  }
});

test('the client sees the post without an account, and cannot see anyone else', async () => {
  const post = await newPost('Look at this one');
  client.signOut();

  const view = await client.get(`/api/review/${post.approval.token}`);
  assert.equal(view.status, 200);
  assert.equal(view.body.caption, 'Look at this one');
  assert.equal(view.body.destinations.length, 1);
  assert.equal(view.body.media.length, 1);
  // The review payload must never leak tokens, ids or anything about the agency.
  assert.equal(JSON.stringify(view.body).includes('acc_'), false);
  assert.equal(view.body.creator.name, 'Blair Conklin');

  const bogus = await client.get('/api/review/not-a-real-token');
  assert.equal(bogus.status, 404);
});

test('asking for changes pulls the post out of the queue, approving puts it back', async () => {
  const owner = await startServer();
  await owner.post('/api/session', { email: 'owner@example.com', password: 'wildwater99' });
  const post = (await owner.post('/api/posts', {
    creatorId: creator.id, caption: 'Round one', mediaIds: [mediaId],
    scheduledAt: new Date(Date.now() + 60000).toISOString(), status: 'scheduled', targets,
  })).body;

  client.signOut();
  const noteless = await client.post(`/api/review/${post.approval.token}`, { decision: 'changes_requested' });
  assert.equal(noteless.status, 400, 'a rejection has to say what to change');

  await client.post(`/api/review/${post.approval.token}`, {
    decision: 'changes_requested', note: 'Swap the first clip', name: 'Blair',
  });
  let current = (await owner.get('/api/posts')).body.find((p) => p.id === post.id);
  assert.equal(current.status, 'draft');
  assert.equal(current.approval.note, 'Swap the first clip');

  await client.post(`/api/review/${post.approval.token}`, { decision: 'approved', name: 'Blair' });
  current = (await owner.get('/api/posts')).body.find((p) => p.id === post.id);
  assert.equal(current.status, 'scheduled');
  assert.equal(current.approval.status, 'approved');
  assert.equal(current.approval.reviewedBy, 'Blair');

  const published = (await owner.post(`/api/posts/${post.id}/publish`, { force: true })).body;
  assert.equal(published.status, 'published');
  await owner.close();
});

test('re-opening review kills the old link', async () => {
  const owner = await startServer();
  await owner.post('/api/session', { email: 'owner@example.com', password: 'wildwater99' });
  const post = (await owner.post('/api/posts', {
    creatorId: creator.id, caption: 'Edit me', mediaIds: [mediaId], status: 'draft', targets,
  })).body;
  const oldToken = post.approval.token;

  const reopened = (await owner.post(`/api/posts/${post.id}/review`, { required: true })).body;
  const newToken = reopened.post.approval.token;
  assert.notEqual(oldToken, newToken);

  client.signOut();
  assert.equal((await client.get(`/api/review/${oldToken}`)).status, 404, 'the link the client already saw is dead');
  assert.equal((await client.get(`/api/review/${newToken}`)).status, 200);
  await owner.close();
});

test('the scheduler leaves unapproved posts alone when they come due', async () => {
  const owner = await startServer();
  await owner.post('/api/session', { email: 'owner@example.com', password: 'wildwater99' });
  const post = (await owner.post('/api/posts', {
    creatorId: creator.id, caption: 'Due but unapproved', mediaIds: [mediaId],
    scheduledAt: new Date(Date.now() - 5000).toISOString(), status: 'scheduled', targets,
  })).body;

  const scheduler = require('../server/scheduler');
  await scheduler.tick();

  const current = (await owner.get('/api/posts')).body.find((p) => p.id === post.id);
  assert.equal(current.status, 'scheduled', 'still queued, not published, not failed');
  assert.equal(current.targets[0].status, 'pending');
  assert.equal(current.targets[0].attempts, 0, 'no attempt is burned on it');
  await owner.close();
});
