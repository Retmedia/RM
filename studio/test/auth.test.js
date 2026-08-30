const test = require('node:test');
const assert = require('node:assert/strict');
const { freshEnv, cleanup, startServer, setupOwner, OWNER } = require('./helpers');

const dir = freshEnv();
let client;

test.before(async () => { client = await startServer(); });
test.after(async () => { await client.close(); cleanup(dir); });

test('an empty studio asks to be set up, and setup closes after the first owner', async () => {
  const before = await client.get('/api/session');
  assert.equal(before.body.needsSetup, true);
  assert.equal(before.body.user, null);

  const user = await setupOwner(client);
  assert.equal(user.role, 'owner');

  const after = await client.get('/api/session');
  assert.equal(after.body.needsSetup, false);
  assert.equal(after.body.user.email, OWNER.email);

  // The bootstrap route must never mint a second admin.
  const second = await client.post('/api/setup', {
    name: 'Intruder', email: 'x@example.com', password: 'letmein12345',
  });
  assert.equal(second.status, 409);
});

test('every private endpoint refuses an anonymous caller', async () => {
  client.signOut();
  const guarded = [
    ['GET', '/api/creators'], ['GET', '/api/accounts'], ['GET', '/api/posts'],
    ['GET', '/api/media'], ['GET', '/api/platforms'], ['GET', '/api/users'],
    ['GET', '/api/insights'], ['GET', '/api/invites'], ['GET', '/api/scheduler'],
  ];
  for (const [method, url] of guarded) {
    const res = method === 'GET' ? await client.get(url) : await client.post(url, {});
    assert.equal(res.status, 401, `${method} ${url} should require a session`);
  }
  const write = await client.post('/api/creators', { name: 'Sneaky' });
  assert.equal(write.status, 401);
});

test('health stays open so a load balancer can reach it', async () => {
  client.signOut();
  assert.equal((await client.get('/api/health')).status, 200);
});

test('signing in and out moves the session', async () => {
  client.signOut();
  assert.equal((await client.get('/api/creators')).status, 401);

  const bad = await client.post('/api/session', { email: OWNER.email, password: 'wrongwrong1' });
  assert.equal(bad.status, 401);

  const good = await client.post('/api/session', { email: OWNER.email, password: OWNER.password });
  assert.equal(good.status, 200);
  assert.equal((await client.get('/api/creators')).status, 200);

  await client.del('/api/session');
  assert.equal((await client.get('/api/creators')).status, 401);
});

test('the session cookie is HttpOnly and SameSite', async () => {
  client.signOut();
  const res = await client.post('/api/session', { email: OWNER.email, password: OWNER.password });
  const cookies = (res.headers.getSetCookie?.() || []).join(' ');
  assert.match(cookies, /HttpOnly/);
  assert.match(cookies, /SameSite=Lax/);
});

test('a manager cannot administer the team, an owner can', async () => {
  await client.post('/api/session', { email: OWNER.email, password: OWNER.password });
  const made = await client.post('/api/users', {
    name: 'Olivia', email: 'olivia@example.com', role: 'manager', password: 'skimboard77',
  });
  assert.equal(made.status, 200);
  assert.equal(made.body.role, 'manager');

  client.signOut();
  await client.post('/api/session', { email: 'olivia@example.com', password: 'skimboard77' });

  // She can do the daily work.
  assert.equal((await client.get('/api/posts')).status, 200);
  assert.equal((await client.post('/api/creators', { name: 'New Client' })).status, 200);

  // But not change who is on the team, or promote herself.
  assert.equal((await client.post('/api/users', {
    name: 'Ghost', email: 'g@example.com', password: 'password123',
  })).status, 403);
  assert.equal((await client.patch(`/api/users/${made.body.id}`, { role: 'owner' })).status, 403);
});

test('the last owner cannot be removed', async () => {
  client.signOut();
  await client.post('/api/session', { email: OWNER.email, password: OWNER.password });
  const me = (await client.get('/api/session')).body.user;
  const res = await client.del(`/api/users/${me.id}`);
  assert.equal(res.status, 400);
});

test('switching someone off ends their live session immediately', async () => {
  client.signOut();
  await client.post('/api/session', { email: OWNER.email, password: OWNER.password });
  const olivia = (await client.get('/api/users')).body.find((u) => u.email === 'olivia@example.com');

  const asOlivia = await startServer();
  try {
    await asOlivia.post('/api/session', { email: 'olivia@example.com', password: 'skimboard77' });
    assert.equal((await asOlivia.get('/api/posts')).status, 200);

    await client.patch(`/api/users/${olivia.id}`, { disabled: true });
    assert.equal((await asOlivia.get('/api/posts')).status, 401, 'her cookie stops working at once');
  } finally {
    await asOlivia.close();
  }
});
