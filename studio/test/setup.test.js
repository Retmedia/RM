const test = require('node:test');
const assert = require('node:assert/strict');
const { freshEnv, cleanup, startServer } = require('./helpers');

// Its own file, because both cases need a studio with nobody in it — and
// re-pointing STUDIO_DATA partway through a file would strand the store
// module on a directory that no longer exists.
const dir = freshEnv();
process.env.STUDIO_LOGIN_ATTEMPTS = '3';

let client;
test.before(async () => { client = await startServer(); });
test.after(async () => {
  await client.close();
  delete process.env.STUDIO_LOGIN_ATTEMPTS;
  cleanup(dir);
});

test('setup refuses a weak password', async () => {
  const short = await client.post('/api/setup', { name: 'A', email: 'a@b.com', password: 'short1' });
  assert.equal(short.status, 400);
  assert.match(short.body.error, /10 characters/);

  const noDigits = await client.post('/api/setup', { name: 'A', email: 'a@b.com', password: 'allletters' });
  assert.equal(noDigits.status, 400);
  assert.match(noDigits.body.error, /number/);
});

test('setup refuses a nonsense email', async () => {
  const res = await client.post('/api/setup', { name: 'A', email: 'not-an-email', password: 'goodpassword1' });
  assert.equal(res.status, 400);
});

test('repeated wrong passwords throttle that account only', async () => {
  await client.post('/api/setup', { name: 'A', email: 'a@b.com', password: 'goodpassword1' });
  client.signOut();

  for (let i = 0; i < 3; i += 1) {
    assert.equal((await client.post('/api/session', { email: 'a@b.com', password: 'nope12345678' })).status, 401);
  }
  assert.equal((await client.post('/api/session', { email: 'a@b.com', password: 'nope12345678' })).status, 429);

  // Someone else on the same connection is unaffected — an office sharing one
  // address must not lock itself out because one person fumbled.
  assert.equal((await client.post('/api/session', { email: 'other@b.com', password: 'whatever1234' })).status, 401);
});
