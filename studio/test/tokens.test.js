const test = require('node:test');
const assert = require('node:assert/strict');
const { freshEnv, cleanup } = require('./helpers');

const dir = freshEnv();
test.after(() => cleanup(dir));

const store = require('../server/store');
const tokens = require('../server/tokens');
const youtube = require('../server/platforms/youtube');
const instagram = require('../server/platforms/instagram');

async function connect({ platform, expiresInMs, refreshToken }) {
  return store.upsertAccount({
    creatorId: null,
    platform,
    platformAccountId: `acct_${platform}_${Math.random().toString(36).slice(2)}`,
    displayName: `${platform} account`,
    username: 'someone',
    scopes: [],
    accessToken: 'access-token',
    refreshToken,
    expiresAt: expiresInMs === null ? null : new Date(Date.now() + expiresInMs).toISOString(),
  });
}

test('a renewable token about to lapse is renewed before anything tries to post', async () => {
  const account = await connect({ platform: 'youtube', expiresInMs: 60 * 1000, refreshToken: 'refresh-me' });
  const real = youtube.refresh;
  let called = 0;
  youtube.refresh = async () => {
    called += 1;
    return {
      accessToken: 'fresh-access',
      refreshToken: 'fresh-refresh',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    };
  };

  try {
    const result = await tokens.sweep();
    assert.equal(called, 1);
    assert.equal(result.renewed, 1);
  } finally {
    youtube.refresh = real;
  }

  const after = await store.accountTokens(account.id);
  assert.equal(after.accessToken, 'fresh-access');
  assert.equal(after.refreshToken, 'fresh-refresh', 'a rotated refresh token is written back');
});

test('a healthy token is left alone', async () => {
  await connect({ platform: 'youtube', expiresInMs: 20 * 24 * 3600_000, refreshToken: 'not-needed' });
  const real = youtube.refresh;
  let called = 0;
  youtube.refresh = async () => { called += 1; throw new Error('should not be called'); };
  try {
    await tokens.sweep();
    assert.equal(called, 0, 'nothing is renewed that does not need renewing');
  } finally {
    youtube.refresh = real;
  }
});

test('Meta cannot renew itself, so it is flagged well before it dies', async () => {
  // Instagram has no refresh method at all — this is the case that silently
  // kills a scheduler around day sixty.
  assert.equal(typeof instagram.refresh, 'undefined');

  const account = await connect({ platform: 'instagram', expiresInMs: 3 * 24 * 3600_000, refreshToken: null });
  const result = await tokens.sweep();
  assert.ok(result.expiring >= 1);

  const after = (await store.listAccounts()).find((a) => a.id === account.id);
  assert.equal(after.status, 'expiring');
  assert.match(after.lastError, /3 days/);
  assert.match(after.lastError, /invite/, 'it says what to actually do about it');
});

test('an already-dead connection is marked for reconnection', async () => {
  const account = await connect({ platform: 'instagram', expiresInMs: -1000, refreshToken: null });
  await tokens.sweep();
  const after = (await store.listAccounts()).find((a) => a.id === account.id);
  assert.equal(after.status, 'needs_reauth');
  assert.match(after.lastError, /expired/i);
});

test('a failed renewal degrades to needs_reauth rather than looking healthy', async () => {
  const account = await connect({ platform: 'youtube', expiresInMs: 60 * 1000, refreshToken: 'revoked' });
  const real = youtube.refresh;
  youtube.refresh = async () => { throw new Error('invalid_grant'); };
  try {
    await tokens.sweep();
  } finally {
    youtube.refresh = real;
  }
  const after = (await store.listAccounts()).find((a) => a.id === account.id);
  assert.equal(after.status, 'needs_reauth');
  assert.match(after.lastError, /invalid_grant/);
});

test('a token with no expiry recorded is not churned', async () => {
  await connect({ platform: 'instagram', expiresInMs: null, refreshToken: null });
  const result = await tokens.sweep();
  assert.ok(result.checked > 0);
  // Nothing to reason about, so it must not be marked broken on a guess.
  const accounts = await store.listAccounts();
  const noExpiry = accounts.find((a) => !a.tokenExpiresAt);
  assert.notEqual(noExpiry.status, 'needs_reauth');
});

test('short-lived tokens are not re-rolled on every sweep', async () => {
  // TikTok rotates its refresh token on each use, so churning a healthy
  // connection is a way to lose it. A token with most of its life left must be
  // left for the publisher to refresh on demand.
  const tiktok = require('../server/platforms/tiktok');
  await connect({ platform: 'tiktok', expiresInMs: 60 * 60 * 1000, refreshToken: 'rotating' });

  const real = tiktok.refresh;
  let called = 0;
  tiktok.refresh = async () => { called += 1; throw new Error('should not be called'); };
  try {
    await tokens.sweep();
    await tokens.sweep();
    assert.equal(called, 0, 'two sweeps, no needless rotation');
  } finally {
    tiktok.refresh = real;
  }
});
