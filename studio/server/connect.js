const crypto = require('node:crypto');
const store = require('./store');
const platforms = require('./platforms');

// Pending OAuth handshakes, keyed by the state parameter. Short-lived and
// in-memory: a connect flow that is not finished within the window is dead.
const pending = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;

function beginConnect({ platform, creatorId }) {
  const adapter = platforms.get(platform);
  const state = crypto.randomBytes(16).toString('hex');
  pending.set(state, { platform, creatorId, createdAt: Date.now() });
  sweep();
  return { state, url: adapter.authUrl(state) };
}

function sweep() {
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const [state, entry] of pending) {
    if (entry.createdAt < cutoff) pending.delete(state);
  }
}

// The callback is the interesting half: one login can come back holding several
// postable accounts, so the result is always a list for the user to assign.
async function completeConnect({ platform, code, state }) {
  const entry = pending.get(state);
  if (!entry) throw new Error('This connection link expired. Start the connect again.');
  if (entry.platform !== platform) throw new Error('Platform mismatch on the OAuth callback.');
  pending.delete(state);

  const adapter = platforms.get(platform);
  const tokens = await adapter.exchangeCode(code);
  const found = await adapter.discover(tokens);
  if (!found.length) {
    throw new Error(
      `That login has no postable ${adapter.meta.name} account. ${adapter.meta.requirements[0]}`,
    );
  }

  const saved = [];
  for (const acct of found) {
    saved.push(await store.upsertAccount({
      creatorId: entry.creatorId || null,
      platform,
      platformAccountId: acct.platformAccountId,
      displayName: acct.displayName,
      username: acct.username,
      avatarUrl: acct.avatarUrl,
      scopes: adapter.meta.scopes,
      accessToken: acct.accessToken || tokens.accessToken,
      refreshToken: tokens.refreshToken || null,
      expiresAt: tokens.expiresAt || null,
      meta: acct.meta,
    }));
  }
  return saved;
}

// Lets the planner and the connect screen be exercised before any developer
// app exists, so the workflow can be reviewed with real creators first.
async function connectDemoAccount({ platform, creatorId, displayName, username }) {
  const adapter = platforms.get(platform);
  return store.upsertAccount({
    creatorId,
    platform,
    platformAccountId: `demo_${platform}_${crypto.randomBytes(4).toString('hex')}`,
    displayName: displayName || username,
    username,
    avatarUrl: '',
    scopes: adapter.meta.scopes,
    accessToken: 'demo-token',
    refreshToken: null,
    expiresAt: null,
    meta: { demo: true },
  });
}

module.exports = { beginConnect, completeConnect, connectDemoAccount };
