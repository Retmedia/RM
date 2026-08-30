const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { newId, writeJSONAtomic, readJSONIfExists, encryptSecret, decryptSecret } = require('./utils');
const { DEFAULT_SLOTS, normalizeSlots } = require('./cadence');

const DATA_ROOT = process.env.STUDIO_DATA
  ? path.resolve(process.env.STUDIO_DATA)
  : path.resolve(__dirname, '..', '.studio-data');

const DB_FILE = path.join(DATA_ROOT, 'studio.json');
const MEDIA_DIR = path.join(DATA_ROOT, 'media');

const EMPTY = {
  users: [], sessions: [], creators: [], accounts: [],
  posts: [], media: [], invites: [], version: 2,
};

let db = null;
let writeChain = Promise.resolve();

async function load() {
  if (db) return db;
  await fs.mkdir(MEDIA_DIR, { recursive: true });
  db = (await readJSONIfExists(DB_FILE)) || structuredClone(EMPTY);
  for (const key of Object.keys(EMPTY)) {
    if (db[key] === undefined) db[key] = structuredClone(EMPTY[key]);
  }
  return db;
}

// Writes are serialized so two concurrent requests cannot interleave a
// read-modify-write and drop one of the changes.
function persist() {
  writeChain = writeChain.then(() => writeJSONAtomic(DB_FILE, db));
  return writeChain;
}

/* ------------------------------------------------------------------- users */

async function listUsers() {
  const d = await load();
  return d.users.map(({ passwordHash, ...rest }) => rest);
}

async function countUsers() {
  const d = await load();
  return d.users.length;
}

async function getUser(id) {
  const d = await load();
  return d.users.find((u) => u.id === id) || null;
}

async function findUserByEmail(email) {
  const d = await load();
  const needle = String(email || '').trim().toLowerCase();
  return d.users.find((u) => u.email === needle) || null;
}

async function createUser({ email, name, role, passwordHash }) {
  const d = await load();
  const normalised = String(email).trim().toLowerCase();
  if (d.users.some((u) => u.email === normalised)) {
    throw new Error('Someone already uses that email address.');
  }
  const user = {
    id: newId('usr'),
    email: normalised,
    name: String(name || '').trim() || normalised,
    role: role === 'owner' ? 'owner' : 'manager',
    passwordHash,
    disabledAt: null,
    createdAt: new Date().toISOString(),
  };
  d.users.push(user);
  await persist();
  const { passwordHash: _, ...rest } = user;
  return rest;
}

async function updateUser(id, patch) {
  const d = await load();
  const user = d.users.find((u) => u.id === id);
  if (!user) return null;
  if (patch.name !== undefined) user.name = String(patch.name).trim();
  if (patch.role !== undefined) user.role = patch.role === 'owner' ? 'owner' : 'manager';
  if (patch.passwordHash !== undefined) user.passwordHash = patch.passwordHash;
  if (patch.disabled !== undefined) {
    user.disabledAt = patch.disabled ? new Date().toISOString() : null;
    // Disabling someone has to end their live sessions too, or they keep
    // working until the cookie happens to expire.
    if (patch.disabled) d.sessions = d.sessions.filter((s) => s.userId !== id);
  }
  await persist();
  const { passwordHash: _, ...rest } = user;
  return rest;
}

async function deleteUser(id) {
  const d = await load();
  const before = d.users.length;
  d.users = d.users.filter((u) => u.id !== id);
  d.sessions = d.sessions.filter((s) => s.userId !== id);
  await persist();
  return d.users.length < before;
}

/* ---------------------------------------------------------------- sessions */

async function createSession({ token, userId, userAgent, expiresAt }) {
  const d = await load();
  d.sessions.push({ token, userId, userAgent, expiresAt, createdAt: new Date().toISOString() });
  await persist();
}

async function getSession(token) {
  const d = await load();
  const session = d.sessions.find((s) => s.token === token);
  if (!session) return null;
  if (session.expiresAt && session.expiresAt < new Date().toISOString()) {
    d.sessions = d.sessions.filter((s) => s.token !== token);
    await persist();
    return null;
  }
  return session;
}

async function deleteSession(token) {
  const d = await load();
  const before = d.sessions.length;
  d.sessions = d.sessions.filter((s) => s.token !== token);
  if (d.sessions.length < before) await persist();
}

async function pruneSessions() {
  const d = await load();
  const now = new Date().toISOString();
  const before = d.sessions.length;
  d.sessions = d.sessions.filter((s) => !s.expiresAt || s.expiresAt >= now);
  if (d.sessions.length < before) await persist();
  return before - d.sessions.length;
}

/* ---------------------------------------------------------------- creators */

async function listCreators() {
  const d = await load();
  return d.creators.map((c) => ({
    ...c,
    accounts: d.accounts.filter((a) => a.creatorId === c.id).map(publicAccount),
  }));
}

async function createCreator({ name, handle, color, notes, slots, requiresApproval }) {
  const d = await load();
  const creator = {
    id: newId('cre'),
    name: String(name).trim(),
    handle: (handle || '').replace(/^@/, '').trim(),
    color: color || pickColor(d.creators.length),
    notes: notes || '',
    slots: normalizeSlots(slots).length ? normalizeSlots(slots) : structuredClone(DEFAULT_SLOTS),
    requiresApproval: !!requiresApproval,
    createdAt: new Date().toISOString(),
  };
  d.creators.push(creator);
  await persist();
  return creator;
}

async function updateCreator(id, patch) {
  const d = await load();
  const creator = d.creators.find((c) => c.id === id);
  if (!creator) return null;
  for (const field of ['name', 'handle', 'color', 'notes']) {
    if (patch[field] !== undefined) creator[field] = patch[field];
  }
  if (patch.slots !== undefined) creator.slots = normalizeSlots(patch.slots);
  if (patch.requiresApproval !== undefined) creator.requiresApproval = !!patch.requiresApproval;
  await persist();
  return creator;
}

async function deleteCreator(id) {
  const d = await load();
  const before = d.creators.length;
  d.creators = d.creators.filter((c) => c.id !== id);
  d.accounts = d.accounts.filter((a) => a.creatorId !== id);
  d.posts = d.posts.filter((p) => p.creatorId !== id);
  await persist();
  return d.creators.length < before;
}

const PALETTE = ['#00d26a', '#5b8cff', '#ff7847', '#c77dff', '#ffd166', '#4cc9f0', '#f72585'];
function pickColor(i) {
  return PALETTE[i % PALETTE.length];
}

/* ---------------------------------------------------------------- accounts */

// The token bundle never leaves the server. Everything the UI needs is here.
function publicAccount(a) {
  const { tokens, ...rest } = a;
  return {
    ...rest,
    tokenExpiresAt: tokens ? tokens.expiresAt || null : null,
  };
}

async function listAccounts() {
  const d = await load();
  return d.accounts.map(publicAccount);
}

async function getAccount(id) {
  const d = await load();
  return d.accounts.find((a) => a.id === id) || null;
}

async function accountTokens(id) {
  const account = await getAccount(id);
  if (!account || !account.tokens) return null;
  return {
    accessToken: decryptSecret(account.tokens.access),
    refreshToken: account.tokens.refresh ? decryptSecret(account.tokens.refresh) : null,
    expiresAt: account.tokens.expiresAt || null,
  };
}

// Connecting the same platform account twice updates it in place rather than
// creating a duplicate row — re-auth is the common path, not a new account.
async function upsertAccount({
  creatorId,
  platform,
  platformAccountId,
  displayName,
  username,
  avatarUrl,
  scopes,
  accessToken,
  refreshToken,
  expiresAt,
  meta,
  connectedVia,
}) {
  const d = await load();
  let account = d.accounts.find(
    (a) => a.platform === platform && a.platformAccountId === platformAccountId,
  );
  if (!account) {
    account = { id: newId('acc'), platform, platformAccountId, createdAt: new Date().toISOString() };
    d.accounts.push(account);
  }
  Object.assign(account, {
    creatorId,
    displayName: displayName || username || platformAccountId,
    username: username || '',
    avatarUrl: avatarUrl || '',
    scopes: scopes || [],
    meta: meta || {},
    status: 'connected',
    lastError: null,
    // Whether the agency connected this or the creator did it themselves from
    // an invite. The second kind is the one that survives a client who will not
    // hand over an ownership role.
    connectedVia: connectedVia || 'agency',
    connectedAt: new Date().toISOString(),
    tokens: {
      access: encryptSecret(accessToken),
      refresh: refreshToken ? encryptSecret(refreshToken) : null,
      expiresAt: expiresAt || null,
    },
  });
  await persist();
  return publicAccount(account);
}

async function setAccountStatus(id, status, lastError) {
  const d = await load();
  const account = d.accounts.find((a) => a.id === id);
  if (!account) return null;
  account.status = status;
  account.lastError = lastError || null;
  await persist();
  return publicAccount(account);
}

async function saveAccountTokens(id, { accessToken, refreshToken, expiresAt }) {
  const d = await load();
  const account = d.accounts.find((a) => a.id === id);
  if (!account) return null;
  account.tokens = {
    access: encryptSecret(accessToken),
    refresh: refreshToken ? encryptSecret(refreshToken) : account.tokens?.refresh || null,
    expiresAt: expiresAt || null,
  };
  await persist();
  return publicAccount(account);
}

async function reassignAccount(id, creatorId) {
  const d = await load();
  const account = d.accounts.find((a) => a.id === id);
  if (!account) return null;
  account.creatorId = creatorId;
  await persist();
  return publicAccount(account);
}

async function disconnectAccount(id) {
  const d = await load();
  const before = d.accounts.length;
  d.accounts = d.accounts.filter((a) => a.id !== id);
  await persist();
  return d.accounts.length < before;
}

/* ------------------------------------------------------------------- posts */

async function listPosts({ from, to, creatorId, status } = {}) {
  const d = await load();
  return d.posts
    .filter((p) => {
      if (creatorId && p.creatorId !== creatorId) return false;
      if (status && p.status !== status) return false;
      if (from && p.scheduledAt && p.scheduledAt < from) return false;
      if (to && p.scheduledAt && p.scheduledAt > to) return false;
      return true;
    })
    .sort((a, b) => String(a.scheduledAt).localeCompare(String(b.scheduledAt)));
}

async function getPost(id) {
  const d = await load();
  return d.posts.find((p) => p.id === id) || null;
}

async function createPost({ creatorId, caption, mediaIds, scheduledAt, status, targets, requiresApproval }) {
  const d = await load();
  const creator = d.creators.find((c) => c.id === creatorId);
  const needsApproval = requiresApproval !== undefined ? !!requiresApproval : !!creator?.requiresApproval;
  const post = {
    id: newId('post'),
    creatorId,
    caption: caption || '',
    mediaIds: mediaIds || [],
    scheduledAt: scheduledAt || null,
    status: status || 'draft',
    targets: (targets || []).map((t) => ({
      accountId: t.accountId,
      captionOverride: t.captionOverride || null,
      options: t.options || {},
      status: 'pending',
      attempts: 0,
      nextAttemptAt: null,
      remoteId: null,
      remoteUrl: null,
      error: null,
      publishedAt: null,
    })),
    approval: {
      required: needsApproval,
      status: needsApproval ? 'pending' : 'not_required',
      // The review link is the token; it is the only thing a client needs and
      // it grants nothing except this one post.
      token: needsApproval ? crypto.randomBytes(16).toString('hex') : null,
      note: null,
      reviewedAt: null,
      reviewedBy: null,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  d.posts.push(post);
  await persist();
  return post;
}

async function updatePost(id, patch) {
  const d = await load();
  const post = d.posts.find((p) => p.id === id);
  if (!post) return null;
  for (const field of ['caption', 'mediaIds', 'scheduledAt', 'status']) {
    if (patch[field] !== undefined) post[field] = patch[field];
  }
  if (patch.targets !== undefined) {
    // Keep publish results for targets that survive the edit; a target that was
    // already published is never silently reset to pending.
    const previous = new Map(post.targets.map((t) => [t.accountId, t]));
    post.targets = patch.targets.map((t) => {
      const old = previous.get(t.accountId);
      return {
        accountId: t.accountId,
        captionOverride: t.captionOverride || null,
        options: t.options || {},
        status: old ? old.status : 'pending',
        attempts: old ? old.attempts : 0,
        nextAttemptAt: old ? old.nextAttemptAt : null,
        remoteId: old ? old.remoteId : null,
        remoteUrl: old ? old.remoteUrl : null,
        error: old ? old.error : null,
        publishedAt: old ? old.publishedAt : null,
      };
    });
  }
  post.updatedAt = new Date().toISOString();
  await persist();
  return post;
}

async function savePost(post) {
  post.updatedAt = new Date().toISOString();
  await persist();
  return post;
}

// A client's review link resolves to exactly one post and carries no session.
async function getPostByToken(token) {
  if (!token) return null;
  const d = await load();
  return d.posts.find((p) => p.approval?.token === token) || null;
}

async function recordReview(postId, { decision, note, reviewedBy }) {
  const d = await load();
  const post = d.posts.find((p) => p.id === postId);
  if (!post || !post.approval?.required) return null;
  if (!['approved', 'changes_requested'].includes(decision)) return null;
  post.approval.status = decision;
  post.approval.note = note || null;
  post.approval.reviewedAt = new Date().toISOString();
  post.approval.reviewedBy = reviewedBy || null;
  // Changes requested pulls the post out of the queue; approving puts it back.
  if (decision === 'changes_requested' && post.status === 'scheduled') post.status = 'draft';
  if (decision === 'approved' && post.status === 'draft' && post.scheduledAt) post.status = 'scheduled';
  post.updatedAt = new Date().toISOString();
  await persist();
  return post;
}

// Re-opening review after an edit: a new token so an old link cannot re-approve
// content the client never saw.
async function resetApproval(postId, required) {
  const d = await load();
  const post = d.posts.find((p) => p.id === postId);
  if (!post) return null;
  post.approval = {
    required: !!required,
    status: required ? 'pending' : 'not_required',
    token: required ? crypto.randomBytes(16).toString('hex') : null,
    note: null,
    reviewedAt: null,
    reviewedBy: null,
  };
  post.updatedAt = new Date().toISOString();
  await persist();
  return post;
}

async function deletePost(id) {
  const d = await load();
  const before = d.posts.length;
  d.posts = d.posts.filter((p) => p.id !== id);
  await persist();
  return d.posts.length < before;
}

/* ----------------------------------------------------------------- invites */

// An invite is a link the creator opens themselves. They authorise with their
// own login, which is the whole point: for YouTube the API only accepts a token
// held by an Owner, and the creator already is one. Nobody's role has to change
// and no password is ever shared.
async function createInvite({ creatorId, platforms: wanted, note, expiresInDays }) {
  const d = await load();
  const invite = {
    id: newId('inv'),
    creatorId,
    token: crypto.randomBytes(24).toString('base64url'),
    platforms: wanted,
    note: note || '',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + (expiresInDays || 14) * 86400000).toISOString(),
    connected: [],
    revokedAt: null,
  };
  d.invites.push(invite);
  await persist();
  return invite;
}

async function getInviteByToken(token) {
  if (!token) return null;
  const d = await load();
  return d.invites.find((i) => i.token === token) || null;
}

function inviteProblem(invite) {
  if (!invite) return 'This link is not valid any more.';
  if (invite.revokedAt) return 'This link has been turned off. Ask for a new one.';
  if (invite.expiresAt && invite.expiresAt < new Date().toISOString()) {
    return 'This link has expired. Ask for a new one.';
  }
  return null;
}

async function listInvites() {
  const d = await load();
  return d.invites.filter((i) => !i.revokedAt);
}

async function recordInviteConnection(inviteId, { platform, accountId, displayName }) {
  const d = await load();
  const invite = d.invites.find((i) => i.id === inviteId);
  if (!invite) return null;
  invite.connected = invite.connected.filter((c) => c.platform !== platform);
  invite.connected.push({ platform, accountId, displayName, at: new Date().toISOString() });
  await persist();
  return invite;
}

async function revokeInvite(id) {
  const d = await load();
  const invite = d.invites.find((i) => i.id === id);
  if (!invite) return false;
  invite.revokedAt = new Date().toISOString();
  await persist();
  return true;
}

/* ------------------------------------------------------------------- media */

async function addMedia({ filename, storedName, mimeType, size, kind }) {
  const d = await load();
  const item = {
    id: newId('med'),
    filename,
    storedName,
    mimeType,
    size,
    kind: kind || (mimeType.startsWith('video/') ? 'video' : 'image'),
    url: `/media/${storedName}`,
    createdAt: new Date().toISOString(),
  };
  d.media.push(item);
  await persist();
  return item;
}

async function listMedia() {
  const d = await load();
  return [...d.media].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function getMediaByIds(ids) {
  const d = await load();
  return (ids || []).map((id) => d.media.find((m) => m.id === id)).filter(Boolean);
}

module.exports = {
  DATA_ROOT,
  MEDIA_DIR,
  load,
  listUsers,
  countUsers,
  getUser,
  findUserByEmail,
  createUser,
  updateUser,
  deleteUser,
  createSession,
  getSession,
  deleteSession,
  pruneSessions,
  listCreators,
  createCreator,
  updateCreator,
  deleteCreator,
  listAccounts,
  getAccount,
  accountTokens,
  upsertAccount,
  setAccountStatus,
  saveAccountTokens,
  reassignAccount,
  disconnectAccount,
  publicAccount,
  listPosts,
  getPost,
  createPost,
  updatePost,
  savePost,
  deletePost,
  getPostByToken,
  recordReview,
  resetApproval,
  createInvite,
  getInviteByToken,
  inviteProblem,
  listInvites,
  recordInviteConnection,
  revokeInvite,
  addMedia,
  listMedia,
  getMediaByIds,
};
