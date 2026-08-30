const test = require('node:test');
const assert = require('node:assert/strict');
const { freshEnv, cleanup, startServer, setupOwner } = require('./helpers');

const dir = freshEnv();
let client;
let creator;
let accounts;
let mediaId;

test.before(async () => {
  client = await startServer();
  await setupOwner(client);

  creator = (await client.post('/api/creators', { name: 'Blair Conklin', handle: 'blairconklin' })).body;
  const connect = require('../server/connect');
  for (const platform of ['tiktok', 'instagram', 'x']) {
    await connect.connectDemoAccount({
      platform, creatorId: creator.id, username: 'blairconklin', displayName: `Blair · ${platform}`,
    });
  }
  accounts = (await client.get('/api/accounts')).body.map((a) => ({ accountId: a.id }));

  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(200, 7)]);
  mediaId = (await client.post('/api/media', png, {
    raw: true, headers: { 'content-type': 'image/png', 'x-filename': 'clip.png' },
  })).body.id;
});

test.after(async () => { await client.close(); cleanup(dir); });

test('a post fans out to every target and one platform cannot stop the rest', async () => {
  const post = (await client.post('/api/posts', {
    creatorId: creator.id,
    caption: 'Skid session',
    mediaIds: [mediaId],
    status: 'draft',
    targets: accounts,
  })).body;

  const published = (await client.post(`/api/posts/${post.id}/publish`, { force: true })).body;
  assert.equal(published.status, 'published');
  assert.equal(published.targets.length, 3);
  for (const target of published.targets) {
    assert.equal(target.status, 'published');
    assert.ok(target.remoteUrl, 'each target records where it landed');
    assert.equal(target.dryRun, true, 'dry run never touches a real platform');
  }
});

test('validation is per platform, against that platform own rules', async () => {
  const long = 'x'.repeat(400);
  const post = (await client.post('/api/posts', {
    creatorId: creator.id, caption: long, mediaIds: [mediaId], status: 'draft', targets: accounts,
  })).body;

  const { problems } = (await client.post(`/api/posts/${post.id}/validate`)).body;
  const byPlatform = Object.fromEntries(problems.map((p) => [p.platform, p.messages]));

  assert.ok(byPlatform.x?.some((m) => /280/.test(m)), 'X rejects 400 characters');
  assert.ok(!byPlatform.instagram, 'Instagram allows 2200, so it stays quiet');
  assert.ok(byPlatform.tiktok?.some((m) => /video/i.test(m)), 'TikTok wants a video');
});

test('a post with no targets is refused rather than silently going nowhere', async () => {
  const res = await client.post('/api/posts', {
    creatorId: creator.id, caption: 'orphan', mediaIds: [mediaId], status: 'draft', targets: [],
  });
  assert.equal(res.status, 400);
});

test('editing a post keeps results for targets that already published', async () => {
  const post = (await client.post('/api/posts', {
    creatorId: creator.id, caption: 'first', mediaIds: [mediaId], status: 'draft', targets: accounts,
  })).body;
  const published = (await client.post(`/api/posts/${post.id}/publish`, { force: true })).body;
  const landed = published.targets[0].remoteId;

  const edited = (await client.patch(`/api/posts/${post.id}`, {
    caption: 'second', targets: accounts,
  })).body;
  assert.equal(edited.caption, 'second');
  assert.equal(edited.targets[0].status, 'published', 'a published target is never reset to pending');
  assert.equal(edited.targets[0].remoteId, landed);
});

test('bulk drop turns a folder of clips into a scheduled month', async () => {
  await client.patch(`/api/creators/${creator.id}`, {
    slots: [
      { day: 1, time: '09:00' }, { day: 1, time: '17:00' },
      { day: 4, time: '09:00' }, { day: 4, time: '17:00' },
    ],
  });

  const ids = [];
  for (let i = 0; i < 9; i += 1) {
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(120, i)]);
    ids.push((await client.post('/api/media', png, {
      raw: true, headers: { 'content-type': 'image/png', 'x-filename': `clip_${i}.png` },
    })).body.id);
  }

  const res = await client.post('/api/posts/bulk', { creatorId: creator.id, mediaIds: ids });
  assert.equal(res.status, 200);
  assert.equal(res.body.created, 9);

  const times = res.body.posts.map((p) => p.scheduledAt);
  assert.equal(new Set(times).size, 9, 'no two clips share a slot');
  assert.deepEqual(times, [...times].sort(), 'they go out in the order given');
  for (const post of res.body.posts) {
    assert.equal(post.targets.length, 3, 'each one hits every connected account');
    assert.equal(post.mediaIds.length, 1);
  }

  // Running it again fills the gaps after, never on top of, what is booked.
  const again = await client.post('/api/posts/bulk', { creatorId: creator.id, mediaIds: [ids[0]] });
  assert.ok(again.body.posts[0].scheduledAt > times[times.length - 1]);
});

test('a bulk drop with no rhythm explains itself instead of failing quietly', async () => {
  const bare = (await client.post('/api/creators', { name: 'No Rhythm' })).body;
  await client.patch(`/api/creators/${bare.id}`, { slots: [] });
  const res = await client.post('/api/posts/bulk', { creatorId: bare.id, mediaIds: [mediaId] });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /posting rhythm/);
});
