const crypto = require('node:crypto');
const store = require('./store');
const platforms = require('./platforms');

// Pending OAuth handshakes, keyed by the state parameter. Short-lived and
// in-memory: a connect flow that is not finished within the window is dead.
const pending = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;

// PKCE, for the platforms that require it (X). The verifier stays here on the
// server and is handed back at the token call; only its hash ever reaches the
// browser or the platform.
function makePkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

// Lets the OAuth callback know where to send the browser back to before it
// consumes the state.
function peekState(state) {
  return pending.get(state) || null;
}

function beginConnect({ platform, creatorId, inviteId, inviteToken }) {
  const adapter = platforms.get(platform);
  const state = crypto.randomBytes(16).toString('hex');
  const pkce = adapter.meta.usesPkce ? makePkce() : null;
  pending.set(state, {
    platform,
    creatorId,
    inviteId: inviteId || null,
    inviteToken: inviteToken || null,
    createdAt: Date.now(),
    codeVerifier: pkce?.verifier,
  });
  sweep();
  return { state, url: adapter.authUrl(state, { codeChallenge: pkce?.challenge }) };
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
  const tokens = await adapter.exchangeCode(code, { codeVerifier: entry.codeVerifier });
  const found = await adapter.discover(tokens);
  if (!found.length) {
    // An empty result is the single most confusing failure on every platform,
    // and it always means something specific. Say which.
    throw new Error(adapter.meta.emptyResultHelp || `That login has no postable ${adapter.meta.name} account.`);
  }

  const saved = [];
  for (const acct of found) {
    saved.push(await store.upsertAccount({
      creatorId: entry.creatorId || null,
      connectedVia: entry.inviteId ? 'invite' : 'agency',
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

  if (entry.inviteId) {
    for (const account of saved) {
      await store.recordInviteConnection(entry.inviteId, {
        platform,
        accountId: account.id,
        displayName: account.displayName,
      });
    }
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

module.exports = { beginConnect, peekState, completeConnect, connectDemoAccount };
