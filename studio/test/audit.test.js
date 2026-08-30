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
  creator = (await client.post('/api/creators', { name: 'Blair', requiresApproval: true })).body;
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

test('a post refused for approval still publishes once the client approves', async () => {
  const post = (await client.post('/api/posts', {
    creatorId: creator.id,
    caption: 'Approve me',
    mediaIds: [mediaId],
    scheduledAt: new Date(Date.now() - 5000).toISOString(),
    status: 'scheduled',
    targets,
  })).body;

  // Someone hits Publish before the client has answered.
  const blocked = await client.post(`/api/posts/${post.id}/publish`, { force: true });
  assert.equal(blocked.body.status, 'awaiting_approval');

  // The client then approves.
  await client.post(`/api/review/${post.approval.token}`, { decision: 'approved', name: 'Blair' });

  // It is due and approved, so the scheduler must take it.
  await require('../server/scheduler').tick();
  const after = (await client.get('/api/posts')).body.find((p) => p.id === post.id);
  assert.equal(after.status, 'published', 'an approved post must not be stranded');
});

test('a post cannot be published twice by two things racing', async () => {
  const open = (await client.post('/api/creators', { name: 'No Approval' })).body;
  const connect = require('../server/connect');
  await connect.connectDemoAccount({
    platform: 'instagram', creatorId: open.id, username: 'na', displayName: 'NA · instagram',
  });
  const openTargets = (await client.get('/api/accounts')).body
    .filter((a) => a.creatorId === open.id).map((a) => ({ accountId: a.id }));

  const post = (await client.post('/api/posts', {
    creatorId: open.id,
    caption: 'Race me',
    mediaIds: [mediaId],
    scheduledAt: new Date(Date.now() - 5000).toISOString(),
    status: 'scheduled',
    targets: openTargets,
  })).body;

  const { publishPost } = require('../server/publisher');
  const scheduler = require('../server/scheduler');
  const instagram = require('../server/platforms/instagram');

  // Count what actually reaches the platform. Two runs both calling publish
  // means two live posts on the account and only one recorded here.
  let sent = 0;
  const real = instagram.publish;
  instagram.publish = async (args) => {
    sent += 1;
    // Yield, so a second run has every chance to interleave — which is exactly
    // what a real network call does.
    await new Promise((r) => setTimeout(r, 40));
    return real(args);
  };

  try {
    await Promise.all([scheduler.tick(), publishPost(post.id)]);
  } finally {
    instagram.publish = real;
  }

  const after = (await client.get('/api/posts')).body.find((p) => p.id === post.id);
  assert.equal(after.targets[0].status, 'published');
  assert.equal(sent, 1, `the post reached the platform ${sent} times; it must be exactly once`);
});

test('slot times mean the agency clock, not whatever the server is set to', async () => {
  const cadence = require('../server/cadence');
  // 09:00 in Los Angeles is 16:00 or 17:00 UTC depending on the season. A slot
  // written as 09:00 must land at the creator's 09:00 wherever this is hosted.
  const slots = [{ day: 3, time: '09:00' }];
  const [when] = cadence.nextOpenSlots({
    slots,
    count: 1,
    from: new Date('2026-08-25T12:00:00Z'),
    timezone: 'America/Los_Angeles',
  });
  const local = new Date(when).toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles', hour: '2-digit', hour12: false,
  });
  assert.match(local, /09/, `expected 09:00 in Los Angeles, got ${local}`);
});

test('a post referencing media that is gone fails loudly instead of posting empty', async () => {
  const open = (await client.get('/api/creators')).body.find((c) => c.name === 'No Approval');
  const openTargets = (await client.get('/api/accounts')).body
    .filter((a) => a.creatorId === open.id).map((a) => ({ accountId: a.id }));

  const post = (await client.post('/api/posts', {
    creatorId: open.id,
    caption: 'Ghost media',
    mediaIds: ['med_doesnotexist'],
    status: 'draft',
    targets: openTargets,
  })).body;

  const { problems } = (await client.post(`/api/posts/${post.id}/validate`)).body;
  const media = problems.find((p) => p.platform === 'media');
  assert.ok(media, 'the missing file is named as the actual cause');
  assert.match(media.messages[0], /missing from the library/);
});

test('a send interrupted by a restart is flagged, never silently retried', async () => {
  const store = require('../server/store');
  const scheduler = require('../server/scheduler');
  const open = (await client.get('/api/creators')).body.find((c) => c.name === 'No Approval');
  const openTargets = (await client.get('/api/accounts')).body
    .filter((a) => a.creatorId === open.id).map((a) => ({ accountId: a.id }));

  const post = (await client.post('/api/posts', {
    creatorId: open.id, caption: 'Killed mid-flight', mediaIds: [mediaId],
    status: 'scheduled', scheduledAt: new Date(Date.now() - 1000).toISOString(), targets: openTargets,
  })).body;

  // Simulate the process dying while the send was in the air.
  const db = await store.load();
  db.posts.find((p) => p.id === post.id).targets[0].status = 'sending';

  assert.equal(await scheduler.recoverInterrupted(), 1);

  const after = (await client.get('/api/posts')).body.find((p) => p.id === post.id);
  assert.equal(after.status, 'needs_check');
  assert.equal(after.targets[0].status, 'unknown');
  assert.match(after.targets[0].error, /may already be live/);

  // And the scheduler must not quietly send it again on the next tick.
  await scheduler.tick();
  const later = (await client.get('/api/posts')).body.find((p) => p.id === post.id);
  assert.equal(later.targets[0].status, 'unknown', 'left alone for a person to resolve');
});
