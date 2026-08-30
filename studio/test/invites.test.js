const test = require('node:test');
const assert = require('node:assert/strict');
const { freshEnv, cleanup, startServer, setupOwner } = require('./helpers');

const dir = freshEnv();
let client;
let creator;

test.before(async () => {
  client = await startServer();
  await setupOwner(client);
  creator = (await client.post('/api/creators', { name: 'Xander Budnick' })).body;
});
test.after(async () => { await client.close(); cleanup(dir); });

test('an invite is scoped to one creator and the platforms you chose', async () => {
  const res = await client.post('/api/invites', {
    creatorId: creator.id, platforms: ['youtube', 'tiktok'], note: 'Quick one',
  });
  assert.equal(res.status, 200);
  assert.match(res.body.link, /\/invite\/[A-Za-z0-9_-]{20,}/);
  assert.deepEqual(res.body.invite.platforms, ['youtube', 'tiktok']);
});

test('the creator opens it without an account and sees only their own ask', async () => {
  const { body } = await client.post('/api/invites', {
    creatorId: creator.id, platforms: ['youtube'], note: 'For the clips channel',
  });
  const token = body.invite.token;

  client.signOut();
  const view = await client.get(`/api/invite/${token}`);
  assert.equal(view.status, 200);
  assert.equal(view.body.creator.name, 'Xander Budnick');
  assert.equal(view.body.note, 'For the clips channel');
  assert.equal(view.body.platforms.length, 1);
  assert.ok(view.body.platforms[0].asks.length, 'it tells them what is actually required');
  // No internal ids or tokens may reach a page anyone with the link can open.
  assert.equal(JSON.stringify(view.body).includes('cre_'), false);
});

test('a platform outside the invite is refused', async () => {
  const owner = await startServer();
  await owner.post('/api/session', { email: 'owner@example.com', password: 'wildwater99' });
  const { body } = await owner.post('/api/invites', { creatorId: creator.id, platforms: ['youtube'] });
  await owner.close();

  client.signOut();
  const res = await client.post(`/api/invite/${body.invite.token}/connect/tiktok`);
  assert.equal(res.status, 400);
});

test('the creator connect sends them to the real consent screen, as the owner they already are', async () => {
  process.env.GOOGLE_CLIENT_ID = 'test-client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
  const owner = await startServer();
  await owner.post('/api/session', { email: 'owner@example.com', password: 'wildwater99' });
  const { body } = await owner.post('/api/invites', { creatorId: creator.id, platforms: ['youtube'] });
  await owner.close();

  client.signOut();
  const res = await client.post(`/api/invite/${body.invite.token}/connect/youtube`);
  assert.equal(res.status, 200);

  const url = new URL(res.body.url);
  assert.equal(url.host, 'accounts.google.com');
  const params = url.searchParams;
  assert.match(params.get('scope'), /youtube\.upload/);
  assert.equal(params.get('access_type'), 'offline', 'offline is what returns a refresh token');
  assert.match(params.get('prompt'), /consent/);
  assert.ok(params.get('state'));
});

test('revoking a link kills it for reading and for connecting', async () => {
  const owner = await startServer();
  await owner.post('/api/session', { email: 'owner@example.com', password: 'wildwater99' });
  const { body } = await owner.post('/api/invites', { creatorId: creator.id, platforms: ['tiktok'] });
  const token = body.invite.token;

  client.signOut();
  assert.equal((await client.get(`/api/invite/${token}`)).status, 200);

  await owner.del(`/api/invites/${body.invite.id}`);

  assert.equal((await client.get(`/api/invite/${token}`)).status, 404);
  assert.equal((await client.post(`/api/invite/${token}/connect/tiktok`)).status, 404);
  await owner.close();
});

test('an expired link stops working on its own', async () => {
  const store = require('../server/store');
  const invite = await store.createInvite({ creatorId: creator.id, platforms: ['tiktok'], expiresInDays: 1 });
  const db = await store.load();
  db.invites.find((i) => i.id === invite.id).expiresAt = new Date(Date.now() - 1000).toISOString();

  client.signOut();
  const res = await client.get(`/api/invite/${invite.token}`);
  assert.equal(res.status, 404);
  assert.match(res.body.error, /expired/i);
});

test('every platform explains the empty-picker failure in words', async () => {
  const platforms = require('../server/platforms');
  for (const meta of platforms.listMeta()) {
    assert.ok(meta.emptyResultHelp, `${meta.id} must say why it came back empty`);
  }
  const youtube = platforms.get('youtube').meta;
  assert.match(youtube.emptyResultHelp, /Owner/, 'the YouTube one names the real cause');
  assert.match(youtube.emptyResultHelp, /invite/i, 'and points at the fix');
});
