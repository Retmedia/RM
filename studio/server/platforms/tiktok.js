const fs = require('node:fs');
const path = require('node:path');
const { DRY_RUN, PlatformError, api, requireEnv, redirectUri, simulatePublish } = require('./base');

const API = 'https://open.tiktokapis.com/v2';

const meta = {
  id: 'tiktok',
  name: 'TikTok',
  color: '#25f4ee',
  // The important honest note: TikTok has no concept of "the accounts on my
  // phone". Each one authorises separately, once.
  multiAccount: 'per-account',
  multiAccountNote:
    'TikTok authorises one account per login. The accounts switched between in your phone app are not visible to any API — each creator taps Connect once, and the connection then lasts until the refresh token is revoked.',
  requirements: [
    'A TikTok developer app with the Content Posting API product enabled.',
    'Until the app passes TikTok audit, everything it posts is forced to SELF_ONLY (private). Audit is what unlocks public posting.',
    'Your domain must be verified with TikTok before media can be pulled by URL.',
  ],
  scopes: ['user.info.basic', 'video.publish', 'video.upload', 'video.list'],
  metricsScopes: ['video.list'],
  limits: {
    captionChars: 2200,
    postsPer24h: 6,
    videoSeconds: 600,
    formats: ['video', 'image'],
  },
  notes: [
    'Creator settings are queried before every post — an account with comments off, or one that has hit its daily limit, is reported before the upload starts.',
    'Refresh tokens rotate on every use, so the newest one always has to be written back.',
  ],
};

function authUrl(state) {
  requireEnv('TIKTOK_CLIENT_KEY');
  const params = new URLSearchParams({
    client_key: process.env.TIKTOK_CLIENT_KEY,
    response_type: 'code',
    scope: meta.scopes.join(','),
    redirect_uri: redirectUri('tiktok'),
    state,
  });
  return `https://www.tiktok.com/v2/auth/authorize/?${params}`;
}

async function exchangeCode(code) {
  requireEnv('TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET');
  const body = new URLSearchParams({
    client_key: process.env.TIKTOK_CLIENT_KEY,
    client_secret: process.env.TIKTOK_CLIENT_SECRET,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri('tiktok'),
  });
  const r = await api(`${API}/oauth/token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  return {
    accessToken: r.access_token,
    refreshToken: r.refresh_token,
    expiresAt: new Date(Date.now() + (r.expires_in || 86400) * 1000).toISOString(),
  };
}

async function refresh(refreshToken) {
  requireEnv('TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET');
  const body = new URLSearchParams({
    client_key: process.env.TIKTOK_CLIENT_KEY,
    client_secret: process.env.TIKTOK_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  const r = await api(`${API}/oauth/token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  return {
    accessToken: r.access_token,
    refreshToken: r.refresh_token,
    expiresAt: new Date(Date.now() + (r.expires_in || 86400) * 1000).toISOString(),
  };
}

// A TikTok token always represents exactly one account, so discovery returns a
// single entry rather than a list.
async function discover({ accessToken }) {
  const r = await api(
    `${API}/user/info/?fields=open_id,union_id,display_name,avatar_url,username`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  const user = r.data?.user || {};
  return [{
    platformAccountId: user.open_id,
    username: user.username || '',
    displayName: user.display_name || user.username || 'TikTok account',
    avatarUrl: user.avatar_url || '',
    accessToken,
    meta: { unionId: user.union_id },
  }];
}

function validate(post, media) {
  const problems = [];
  const videos = media.filter((m) => m.kind === 'video');
  // The upload path here is the video one; photo posts use a different init
  // call and are not wired up yet, so say that rather than failing at publish.
  if (!videos.length) problems.push('TikTok needs a video — photo posts are not wired up yet.');
  if (videos.length > 1) problems.push('TikTok takes one video per post.');
  if (post.caption.length > meta.limits.captionChars) {
    problems.push(`Caption is ${post.caption.length} characters; TikTok allows ${meta.limits.captionChars}.`);
  }
  return problems;
}

async function publish({ account, tokens, caption, media, options }) {
  if (DRY_RUN) return simulatePublish('tiktok', account);

  const token = tokens.accessToken;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' };

  // TikTok requires the creator's current settings to be read first; it also
  // tells us up front whether they have posts left today.
  const info = await api(`${API}/post/publish/creator_info/query/`, { method: 'POST', headers });
  const creator = info.data || {};
  if (creator.max_video_post_duration_sec && media[0].durationSec > creator.max_video_post_duration_sec) {
    throw new PlatformError(
      `Video is longer than this account can post (${creator.max_video_post_duration_sec}s).`,
    );
  }

  const privacy = options.privacy
    || (creator.privacy_level_options || []).find((p) => p === 'PUBLIC_TO_EVERYONE')
    || (creator.privacy_level_options || [])[0]
    || 'SELF_ONLY';

  const video = media[0];
  const filePath = localPath(video);
  const size = fs.statSync(filePath).size;

  const init = await api(`${API}/post/publish/video/init/`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      post_info: {
        title: caption.slice(0, meta.limits.captionChars),
        privacy_level: privacy,
        disable_comment: !!options.disableComment,
        disable_duet: !!options.disableDuet,
        disable_stitch: !!options.disableStitch,
      },
      source_info: {
        source: 'FILE_UPLOAD',
        video_size: size,
        chunk_size: size,
        total_chunk_count: 1,
      },
    }),
  });

  const uploadUrl = init.data?.upload_url;
  const publishId = init.data?.publish_id;
  if (!uploadUrl || !publishId) throw new PlatformError('TikTok did not return an upload URL.', { retryable: true });

  const upload = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': video.mimeType || 'video/mp4',
      'Content-Length': String(size),
      'Content-Range': `bytes 0-${size - 1}/${size}`,
    },
    body: fs.createReadStream(filePath),
    duplex: 'half',
  });
  if (!upload.ok) {
    throw new PlatformError(`TikTok upload failed: ${await upload.text()}`, { retryable: true });
  }

  const status = await waitForPublish(publishId, headers);
  return {
    remoteId: status.publicaly_available_post_id?.[0] || publishId,
    remoteUrl: account.username ? `https://tiktok.com/@${account.username}` : null,
    privacy,
  };
}

async function waitForPublish(publishId, headers, timeoutMs = 10 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await api(`${API}/post/publish/status/fetch/`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ publish_id: publishId }),
    });
    const data = r.data || {};
    if (data.status === 'PUBLISH_COMPLETE') return data;
    if (data.status === 'FAILED') {
      throw new PlatformError(`TikTok rejected the video: ${data.fail_reason || 'unknown reason'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new PlatformError('TikTok did not finish processing in time.', { retryable: true });
}

function localPath(item) {
  const root = process.env.STUDIO_DATA
    ? path.resolve(process.env.STUDIO_DATA)
    : path.resolve(__dirname, '..', '..', '.studio-data');
  return path.join(root, 'media', item.storedName);
}

// Needs video.list, which is a separate scope from publishing — an account
// connected before this was added reports nothing until it reconnects.
async function fetchMetrics({ tokens, remoteId }) {
  if (DRY_RUN) return null;
  const r = await api(
    `${API}/video/query/?fields=id,like_count,comment_count,share_count,view_count`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify({ filters: { video_ids: [remoteId] } }),
    },
  );
  const video = r.data?.videos?.[0];
  if (!video) return null;
  return {
    views: video.view_count ?? null,
    likes: video.like_count ?? null,
    comments: video.comment_count ?? null,
    shares: video.share_count ?? null,
    saves: null,
  };
}

module.exports = { meta, authUrl, exchangeCode, refresh, discover, validate, publish, fetchMetrics };
