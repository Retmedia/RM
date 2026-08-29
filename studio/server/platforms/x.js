const fs = require('node:fs');
const path = require('node:path');
const { DRY_RUN, PlatformError, api, requireEnv, redirectUri, simulatePublish } = require('./base');

const API = 'https://api.x.com/2';

const meta = {
  id: 'x',
  name: 'X',
  color: '#6b7785',
  // Like TikTok: a token is one account. No organisation layer to enumerate.
  multiAccount: 'per-account',
  multiAccountNote:
    'One login authorises one X account. Each creator taps Connect once from their own login; the refresh token then keeps it alive without asking again.',
  requirements: [
    'An X developer app on a paid API tier — the free tier’s monthly post cap is too low to run a client account on.',
    'OAuth 2.0 with PKCE enabled, and the app set to "Web App / Automated App" so it gets a client secret.',
    'Read and write permissions on the app, set before the creator authorises — changing them later forces everyone to reconnect.',
  ],
  // offline.access is what returns a refresh token; without it the connection
  // dies in two hours and every creator has to re-authorise.
  scopes: ['tweet.read', 'tweet.write', 'users.read', 'media.write', 'offline.access'],
  metricsScopes: ['tweet.read'],
  usesPkce: true,
  emptyResultHelp:
    'X authorised the login but returned no account. Check the app has read and write permissions, then open the invite link again.',
  creatorCanSelfConnect: true,
  limits: {
    captionChars: 280,
    postsPer24h: 100,
    videoSeconds: 140,
    formats: ['text', 'image', 'video'],
  },
  notes: [
    'This is the only platform here that costs money to post through. Check the current tier pricing before quoting a client — it is a real line item, unlike Meta and TikTok.',
    'The 280-character limit is the free/basic ceiling; a Premium account on the same handle can post far longer. Studio validates against 280 so nothing is silently truncated.',
    'X moved media upload from the v1.1 endpoint to v2 — verify the upload command shape against the current docs before the first live post.',
  ],
};

/* ------------------------------------------------------------------- oauth */

function authUrl(state, { codeChallenge } = {}) {
  requireEnv('X_CLIENT_ID');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.X_CLIENT_ID,
    redirect_uri: redirectUri('x'),
    scope: meta.scopes.join(' '),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `https://x.com/i/oauth2/authorize?${params}`;
}

// X wants the client credentials as Basic auth on the token call, not in the body.
function basicAuth() {
  requireEnv('X_CLIENT_ID', 'X_CLIENT_SECRET');
  const pair = `${process.env.X_CLIENT_ID}:${process.env.X_CLIENT_SECRET}`;
  return `Basic ${Buffer.from(pair).toString('base64')}`;
}

async function exchangeCode(code, { codeVerifier } = {}) {
  const r = await api(`${API}/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: basicAuth(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri('x'),
      code_verifier: codeVerifier,
    }),
  });
  return {
    accessToken: r.access_token,
    refreshToken: r.refresh_token || null,
    expiresAt: new Date(Date.now() + (r.expires_in || 7200) * 1000).toISOString(),
  };
}

async function refresh(refreshToken) {
  const r = await api(`${API}/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: basicAuth(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  });
  return {
    accessToken: r.access_token,
    // X rotates the refresh token on every use — losing the new one means the
    // creator has to reconnect, so always write it back.
    refreshToken: r.refresh_token || refreshToken,
    expiresAt: new Date(Date.now() + (r.expires_in || 7200) * 1000).toISOString(),
  };
}

async function discover({ accessToken }) {
  const r = await api(`${API}/users/me?user.fields=profile_image_url,username,name`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const user = r.data;
  if (!user) throw new PlatformError('X did not return an account for that login.');
  return [{
    platformAccountId: user.id,
    username: user.username,
    displayName: user.name || user.username,
    avatarUrl: user.profile_image_url || '',
    accessToken,
    meta: {},
  }];
}

/* -------------------------------------------------------------- validation */

function validate(post, media) {
  const problems = [];
  const videos = media.filter((m) => m.kind === 'video');
  const images = media.filter((m) => m.kind === 'image');

  if (!media.length && !post.caption.trim()) problems.push('An X post needs text or media.');
  if (post.caption.length > meta.limits.captionChars) {
    problems.push(`Caption is ${post.caption.length} characters; X allows ${meta.limits.captionChars}.`);
  }
  // X's own composer rules: one video, or up to four images, never both.
  if (videos.length > 1) problems.push('X takes one video per post.');
  if (videos.length && images.length) problems.push('X cannot mix a video and photos in one post.');
  if (images.length > 4) problems.push(`${images.length} images; X allows 4.`);
  return problems;
}

/* ----------------------------------------------------------------- publish */

async function publish({ account, tokens, caption, media, options }) {
  if (DRY_RUN) return simulatePublish('x', account);

  const mediaIds = [];
  for (const item of media) mediaIds.push(await uploadMedia(item, tokens.accessToken));

  const body = { text: caption.slice(0, meta.limits.captionChars) };
  if (mediaIds.length) body.media = { media_ids: mediaIds };
  if (options.replyToId) body.reply = { in_reply_to_tweet_id: options.replyToId };

  const r = await api(`${API}/tweets`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokens.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const id = r.data?.id;
  if (!id) throw new PlatformError('X accepted the request but returned no post id.', { retryable: true });
  return {
    remoteId: id,
    remoteUrl: `https://x.com/${account.username || 'i'}/status/${id}`,
  };
}

// Chunked upload: INIT, then APPEND each 4MB slice, then FINALIZE. Video is
// transcoded afterwards, so FINALIZE is followed by a status poll.
const CHUNK_BYTES = 4 * 1024 * 1024;

async function uploadMedia(item, accessToken) {
  const filePath = localPath(item);
  const size = fs.statSync(filePath).size;
  const auth = { Authorization: `Bearer ${accessToken}` };

  const init = await api(`${API}/media/upload`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      command: 'INIT',
      total_bytes: String(size),
      media_type: item.mimeType,
      media_category: item.kind === 'video' ? 'tweet_video' : 'tweet_image',
    }),
  });
  const mediaId = init.data?.id || init.media_id_string;
  if (!mediaId) throw new PlatformError('X did not return a media id.', { retryable: true });

  const handle = fs.openSync(filePath, 'r');
  try {
    let index = 0;
    for (let offset = 0; offset < size; offset += CHUNK_BYTES) {
      const length = Math.min(CHUNK_BYTES, size - offset);
      const chunk = Buffer.alloc(length);
      fs.readSync(handle, chunk, 0, length, offset);

      const form = new FormData();
      form.append('command', 'APPEND');
      form.append('media_id', mediaId);
      form.append('segment_index', String(index));
      form.append('media', new Blob([chunk]));

      const res = await fetch(`${API}/media/upload`, { method: 'POST', headers: auth, body: form });
      if (!res.ok) {
        throw new PlatformError(`X rejected chunk ${index}: ${await res.text()}`, { retryable: true });
      }
      index += 1;
    }
  } finally {
    fs.closeSync(handle);
  }

  const done = await api(`${API}/media/upload`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ command: 'FINALIZE', media_id: mediaId }),
  });

  if (done.data?.processing_info || done.processing_info) {
    await waitForProcessing(mediaId, auth);
  }
  return mediaId;
}

async function waitForProcessing(mediaId, auth, timeoutMs = 10 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await api(`${API}/media/upload?command=STATUS&media_id=${mediaId}`, { headers: auth });
    const info = r.data?.processing_info || r.processing_info;
    if (!info || info.state === 'succeeded') return;
    if (info.state === 'failed') {
      throw new PlatformError(`X could not process the video: ${info.error?.message || 'unknown reason'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, (info.check_after_secs || 5) * 1000));
  }
  throw new PlatformError('X did not finish processing the video in time.', { retryable: true });
}

/* ----------------------------------------------------------------- metrics */

async function fetchMetrics({ tokens, remoteId }) {
  if (DRY_RUN) return null;
  const r = await api(`${API}/tweets/${remoteId}?tweet.fields=public_metrics`, {
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
  });
  const m = r.data?.public_metrics;
  if (!m) return null;
  return {
    // impression_count is only returned to the account that owns the post,
    // which is exactly the token we are holding.
    views: m.impression_count ?? null,
    likes: m.like_count ?? null,
    comments: m.reply_count ?? null,
    shares: (m.retweet_count || 0) + (m.quote_count || 0),
    saves: m.bookmark_count ?? null,
  };
}

function localPath(item) {
  const root = process.env.STUDIO_DATA
    ? path.resolve(process.env.STUDIO_DATA)
    : path.resolve(__dirname, '..', '..', '.studio-data');
  return path.join(root, 'media', item.storedName);
}

module.exports = { meta, authUrl, exchangeCode, refresh, discover, validate, publish, fetchMetrics };
