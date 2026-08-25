const path = require('node:path');
const fs = require('node:fs/promises');
const { newId, writeJSONAtomic, readJSONIfExists, encryptSecret, decryptSecret } = require('./utils');

const DATA_ROOT = process.env.STUDIO_DATA
  ? path.resolve(process.env.STUDIO_DATA)
  : path.resolve(__dirname, '..', '.studio-data');

const DB_FILE = path.join(DATA_ROOT, 'studio.json');
const MEDIA_DIR = path.join(DATA_ROOT, 'media');

const EMPTY = { creators: [], accounts: [], posts: [], media: [], version: 1 };

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

/* ---------------------------------------------------------------- creators */

async function listCreators() {
  const d = await load();
  return d.creators.map((c) => ({
    ...c,
    accounts: d.accounts.filter((a) => a.creatorId === c.id).map(publicAccount),
  }));
}

async function createCreator({ name, handle, color, notes }) {
  const d = await load();
  const creator = {
    id: newId('cre'),
    name: String(name).trim(),
    handle: (handle || '').replace(/^@/, '').trim(),
    color: color || pickColor(d.creators.length),
    notes: notes || '',
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

async function createPost({ creatorId, caption, mediaIds, scheduledAt, status, targets }) {
  const d = await load();
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

async function deletePost(id) {
  const d = await load();
  const before = d.posts.length;
  d.posts = d.posts.filter((p) => p.id !== id);
  await persist();
  return d.posts.length < before;
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
  addMedia,
  listMedia,
  getMediaByIds,
};
