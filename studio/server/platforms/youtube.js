const fs = require('node:fs');
const path = require('node:path');
const { DRY_RUN, PlatformError, api, requireEnv, redirectUri, simulatePublish } = require('./base');

const OAUTH = 'https://oauth2.googleapis.com';
const API = 'https://www.googleapis.com/youtube/v3';
const UPLOAD = 'https://www.googleapis.com/upload/youtube/v3';

const meta = {
  id: 'youtube',
  name: 'YouTube',
  color: '#ff0033',
  // This is the one where the "channels I was given access to" intuition holds.
  multiAccount: 'picker',
  multiAccountNote:
    'Google shows a channel picker during sign-in listing every channel you own or have been granted Manager access to, including Brand Accounts. Run the connect flow once per channel and pick a different one each time — no separate password is ever needed.',
  requirements: [
    'A Google Cloud project with the YouTube Data API v3 enabled.',
    'OAuth consent screen verified, because youtube.upload is a sensitive scope.',
    'Manager (not just Communications Manager) permission on any channel you did not create.',
  ],
  scopes: [
    'https://www.googleapis.com/auth/youtube.upload',
    'https://www.googleapis.com/auth/youtube.readonly',
  ],
  limits: {
    captionChars: 5000,
    titleChars: 100,
    postsPer24h: 6,
    videoSeconds: 43200,
    formats: ['video'],
  },
  notes: [
    'The real daily ceiling is quota, not post count: a new project gets 10,000 units a day and each upload costs 1,600, so about six uploads until you request an increase.',
    'A brand-new API project uploads as private until the project passes its own verification — the video is there, it just is not public yet.',
  ],
};

function authUrl(state) {
  requireEnv('GOOGLE_CLIENT_ID');
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri('youtube'),
    response_type: 'code',
    scope: meta.scopes.join(' '),
    access_type: 'offline',
    // Force the picker every time so the next connection can land on a
    // different managed channel instead of silently reusing the last one.
    prompt: 'consent select_account',
    include_granted_scopes: 'true',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function exchangeCode(code) {
  requireEnv('GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET');
  const r = await api(`${OAUTH}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri('youtube'),
    }),
  });
  return {
    accessToken: r.access_token,
    refreshToken: r.refresh_token,
    expiresAt: new Date(Date.now() + (r.expires_in || 3600) * 1000).toISOString(),
  };
}

async function refresh(refreshToken) {
  requireEnv('GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET');
  const r = await api(`${OAUTH}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  return {
    accessToken: r.access_token,
    // Google only returns a refresh token on first consent; keep the old one.
    refreshToken: r.refresh_token || refreshToken,
    expiresAt: new Date(Date.now() + (r.expires_in || 3600) * 1000).toISOString(),
  };
}

// The token is already scoped to the channel chosen in the picker, so this
// returns that one channel.
async function discover({ accessToken }) {
  const r = await api(`${API}/channels?part=snippet,contentDetails&mine=true`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return (r.items || []).map((c) => ({
    platformAccountId: c.id,
    username: c.snippet.customUrl ? c.snippet.customUrl.replace(/^@/, '') : '',
    displayName: c.snippet.title,
    avatarUrl: c.snippet.thumbnails?.default?.url || '',
    accessToken,
    meta: { uploadsPlaylist: c.contentDetails?.relatedPlaylists?.uploads },
  }));
}

function validate(post, media) {
  const problems = [];
  const videos = media.filter((m) => m.kind === 'video');
  if (videos.length !== 1) problems.push('YouTube takes exactly one video per upload.');
  const title = firstLine(post.caption);
  if (!title) problems.push('YouTube needs a title — the first line of the caption is used.');
  if (title.length > meta.limits.titleChars) {
    problems.push(`Title is ${title.length} characters; YouTube allows ${meta.limits.titleChars}.`);
  }
  if (title.includes('<') || title.includes('>')) problems.push('YouTube titles cannot contain < or >.');
  return problems;
}

function firstLine(caption) {
  return String(caption || '').split('\n')[0].trim();
}

async function publish({ account, tokens, caption, media, options }) {
  if (DRY_RUN) return simulatePublish('youtube', account);

  const video = media.find((m) => m.kind === 'video');
  const filePath = localPath(video);
  const size = fs.statSync(filePath).size;
  const title = firstLine(caption).slice(0, meta.limits.titleChars);
  const description = caption.split('\n').slice(1).join('\n').slice(0, meta.limits.captionChars);

  const metadata = {
    snippet: {
      title,
      description,
      tags: options.tags || [],
      categoryId: options.categoryId || '22',
    },
    status: {
      privacyStatus: options.privacy || 'public',
      selfDeclaredMadeForKids: !!options.madeForKids,
    },
  };

  // Resumable upload: ask for a session URL, then send the file to it.
  const start = await fetch(
    `${UPLOAD}/videos?uploadType=resumable&part=snippet,status`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        'Content-Type': 'application/json',
        'X-Upload-Content-Length': String(size),
        'X-Upload-Content-Type': video.mimeType || 'video/*',
      },
      body: JSON.stringify(metadata),
    },
  );
  if (!start.ok) {
    const text = await start.text();
    throw new PlatformError(`YouTube refused the upload session: ${text}`, {
      retryable: start.status >= 500,
      needsReauth: start.status === 401,
    });
  }
  const sessionUrl = start.headers.get('location');
  if (!sessionUrl) throw new PlatformError('YouTube did not return an upload session URL.', { retryable: true });

  const upload = await fetch(sessionUrl, {
    method: 'PUT',
    headers: { 'Content-Length': String(size), 'Content-Type': video.mimeType || 'video/*' },
    body: fs.createReadStream(filePath),
    duplex: 'half',
  });
  const body = await upload.json().catch(() => ({}));
  if (!upload.ok) {
    throw new PlatformError(
      `YouTube upload failed: ${body?.error?.message || upload.status}`,
      { retryable: upload.status >= 500 },
    );
  }
  return { remoteId: body.id, remoteUrl: `https://youtube.com/watch?v=${body.id}` };
}

function localPath(item) {
  const root = process.env.STUDIO_DATA
    ? path.resolve(process.env.STUDIO_DATA)
    : path.resolve(__dirname, '..', '..', '.studio-data');
  return path.join(root, 'media', item.storedName);
}

// videos.list costs 1 quota unit against the same daily budget uploads spend,
// so refreshing metrics is cheap next to publishing.
async function fetchMetrics({ tokens, remoteId }) {
  if (DRY_RUN) return null;
  const r = await api(`${API}/videos?part=statistics&id=${remoteId}`, {
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
  });
  const stats = r.items?.[0]?.statistics;
  if (!stats) return null;
  const num = (v) => (v === undefined ? null : Number(v));
  return {
    views: num(stats.viewCount),
    likes: num(stats.likeCount),
    comments: num(stats.commentCount),
    shares: null,
    saves: null,
  };
}

module.exports = { meta, authUrl, exchangeCode, refresh, discover, validate, publish, fetchMetrics };
