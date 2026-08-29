const fs = require('node:fs');
const path = require('node:path');
const { DRY_RUN, PlatformError, api, requireEnv, redirectUri, simulatePublish } = require('./base');

const GRAPH = 'https://graph.facebook.com/v21.0';

const meta = {
  id: 'facebook',
  name: 'Facebook',
  color: '#1877f2',
  multiAccount: 'bulk',
  multiAccountNote:
    'One Meta login returns every Page you have a publishing role on. This is the one platform where "all my accounts at once" already works exactly as you would expect.',
  requirements: [
    'You publish to Pages, never to a personal profile.',
    'You need a publishing role (Admin, Editor or the Content task) on each Page.',
    'The Meta app needs Advanced Access for pages_manage_posts.',
  ],
  scopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'read_insights', 'business_management'],
  metricsScopes: ['read_insights'],
  emptyResultHelp:
    'That Meta login has no Page with a publishing role on it. The creator needs to be Admin or Editor of a Page — a personal profile cannot be posted to.',
  creatorCanSelfConnect: true,
  limits: {
    captionChars: 63206,
    postsPer24h: 50,
    videoSeconds: 5400,
    formats: ['image', 'video', 'text', 'reel'],
  },
  notes: [
    'Reels go through a separate three-phase upload (start, transfer, finish) from ordinary videos.',
    'Page access tokens returned with a long-lived user token do not themselves expire, so Pages stay connected the longest of any platform here.',
  ],
};

function authUrl(state) {
  requireEnv('META_APP_ID');
  const params = new URLSearchParams({
    client_id: process.env.META_APP_ID,
    redirect_uri: redirectUri('facebook'),
    state,
    scope: meta.scopes.join(','),
    response_type: 'code',
  });
  return `https://www.facebook.com/v21.0/dialog/oauth?${params}`;
}

async function exchangeCode(code) {
  requireEnv('META_APP_ID', 'META_APP_SECRET');
  const params = new URLSearchParams({
    client_id: process.env.META_APP_ID,
    client_secret: process.env.META_APP_SECRET,
    redirect_uri: redirectUri('facebook'),
    code,
  });
  const short = await api(`${GRAPH}/oauth/access_token?${params}`);
  const longParams = new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: process.env.META_APP_ID,
    client_secret: process.env.META_APP_SECRET,
    fb_exchange_token: short.access_token,
  });
  const long = await api(`${GRAPH}/oauth/access_token?${longParams}`);
  return {
    accessToken: long.access_token,
    expiresAt: long.expires_in ? new Date(Date.now() + long.expires_in * 1000).toISOString() : null,
  };
}

async function discover({ accessToken }) {
  const pages = await api(
    `${GRAPH}/me/accounts?fields=id,name,username,access_token,picture{url},tasks&limit=100&access_token=${accessToken}`,
  );
  return (pages.data || [])
    .filter((p) => !p.tasks || p.tasks.includes('CREATE_CONTENT'))
    .map((p) => ({
      platformAccountId: p.id,
      username: p.username || '',
      displayName: p.name,
      avatarUrl: p.picture?.data?.url || '',
      accessToken: p.access_token,
      meta: { tasks: p.tasks || [] },
    }));
}

function validate(post, media) {
  const problems = [];
  if (!media.length && !post.caption.trim()) {
    problems.push('A Facebook post needs either text or media.');
  }
  if (media.length > 1 && media.some((m) => m.kind === 'video')) {
    problems.push('Post one video at a time — Facebook cannot mix a video into a multi-photo post.');
  }
  return problems;
}

async function publish({ account, tokens, caption, media, options }) {
  if (DRY_RUN) return simulatePublish('facebook', account);

  const pageId = account.platformAccountId;
  const token = tokens.accessToken;
  const video = media.find((m) => m.kind === 'video');

  if (video && options.asReel !== false) return publishReel({ pageId, token, caption, video });

  if (video) {
    const params = new URLSearchParams({ access_token: token, description: caption, file_url: absoluteUrl(video) });
    const r = await api(`${GRAPH}/${pageId}/videos`, { method: 'POST', body: params });
    return { remoteId: r.id, remoteUrl: `https://facebook.com/${r.id}` };
  }

  if (media.length) {
    const photoIds = [];
    for (const item of media) {
      const params = new URLSearchParams({
        access_token: token,
        url: absoluteUrl(item),
        published: 'false',
      });
      const r = await api(`${GRAPH}/${pageId}/photos`, { method: 'POST', body: params });
      photoIds.push(r.id);
    }
    const params = new URLSearchParams({ access_token: token, message: caption });
    photoIds.forEach((id, i) => params.set(`attached_media[${i}]`, JSON.stringify({ media_fbid: id })));
    const r = await api(`${GRAPH}/${pageId}/feed`, { method: 'POST', body: params });
    return { remoteId: r.id, remoteUrl: `https://facebook.com/${r.id}` };
  }

  const params = new URLSearchParams({ access_token: token, message: caption });
  const r = await api(`${GRAPH}/${pageId}/feed`, { method: 'POST', body: params });
  return { remoteId: r.id, remoteUrl: `https://facebook.com/${r.id}` };
}

// Reels use a resumable upload rather than a URL fetch, so the file is sent
// from disk in one binary transfer.
async function publishReel({ pageId, token, caption, video }) {
  const start = await api(`${GRAPH}/${pageId}/video_reels`, {
    method: 'POST',
    body: new URLSearchParams({ access_token: token, upload_phase: 'start' }),
  });
  const filePath = localPath(video);
  const size = fs.statSync(filePath).size;
  const upload = await fetch(`https://rupload.facebook.com/video-upload/v21.0/${start.video_id}`, {
    method: 'POST',
    headers: {
      Authorization: `OAuth ${token}`,
      offset: '0',
      file_size: String(size),
      'Content-Type': 'application/octet-stream',
    },
    body: fs.createReadStream(filePath),
    duplex: 'half',
  });
  if (!upload.ok) {
    throw new PlatformError(`Reel upload failed: ${await upload.text()}`, { retryable: true });
  }
  const finish = await api(`${GRAPH}/${pageId}/video_reels`, {
    method: 'POST',
    body: new URLSearchParams({
      access_token: token,
      video_id: start.video_id,
      upload_phase: 'finish',
      video_state: 'PUBLISHED',
      description: caption,
    }),
  });
  if (!finish.success) throw new PlatformError('Facebook did not accept the finished Reel.', { retryable: true });
  return { remoteId: start.video_id, remoteUrl: `https://facebook.com/reel/${start.video_id}` };
}

function absoluteUrl(item) {
  const base = process.env.STUDIO_PUBLIC_URL;
  if (!base || base.includes('localhost')) {
    throw new PlatformError('Set STUDIO_PUBLIC_URL to a publicly reachable host before publishing to Facebook.');
  }
  return `${base}${item.url}`;
}

function localPath(item) {
  const root = process.env.STUDIO_DATA
    ? path.resolve(process.env.STUDIO_DATA)
    : path.resolve(__dirname, '..', '..', '.studio-data');
  return path.join(root, 'media', item.storedName);
}

async function fetchMetrics({ tokens, remoteId }) {
  if (DRY_RUN) return null;
  const metrics = 'post_impressions,post_video_views,post_reactions_by_type_total';
  const r = await api(`${GRAPH}/${remoteId}/insights?metric=${metrics}&access_token=${tokens.accessToken}`);
  const byName = Object.fromEntries((r.data || []).map((m) => [m.name, m.values?.[0]?.value ?? 0]));
  const reactions = byName.post_reactions_by_type_total;
  return {
    views: byName.post_video_views ?? byName.post_impressions ?? null,
    likes: reactions && typeof reactions === 'object'
      ? Object.values(reactions).reduce((a, b) => a + b, 0)
      : reactions ?? null,
    comments: null,
    shares: null,
    saves: null,
  };
}

module.exports = { meta, authUrl, exchangeCode, discover, validate, publish, fetchMetrics };
