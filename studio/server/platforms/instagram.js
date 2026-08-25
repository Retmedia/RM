const { DRY_RUN, PlatformError, api, requireEnv, redirectUri, simulatePublish } = require('./base');

const GRAPH = 'https://graph.facebook.com/v21.0';

const meta = {
  id: 'instagram',
  name: 'Instagram',
  color: '#e1306c',
  // One agency login can surface every IG account inside the Business Manager,
  // which is the closest thing to "it already knows all my accounts".
  multiAccount: 'bulk',
  multiAccountNote:
    'One Meta login returns every Instagram Professional account attached to a Page you manage. Add the creators to your Business Manager once and they all appear together.',
  requirements: [
    'Each account must be an Instagram Professional account (Business or Creator) — a personal account cannot be published to by any API.',
    'The account must be linked to a Facebook Page.',
    'You need a Meta app with Advanced Access for instagram_content_publish, which requires App Review plus Business Verification.',
  ],
  scopes: [
    'instagram_basic',
    'instagram_content_publish',
    'pages_show_list',
    'pages_read_engagement',
    'business_management',
  ],
  limits: {
    captionChars: 2200,
    hashtags: 30,
    postsPer24h: 50,
    videoSeconds: 900,
    formats: ['image', 'video', 'carousel'],
  },
  notes: [
    'Feed posts, Reels and carousels are the well-trodden paths. Confirm Stories support against the current Content Publishing docs before promising it to a client.',
    'Media is pulled by Meta from a public URL — the file has to be reachable from the internet at publish time.',
  ],
};

function authUrl(state) {
  requireEnv('META_APP_ID');
  const params = new URLSearchParams({
    client_id: process.env.META_APP_ID,
    redirect_uri: redirectUri('instagram'),
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
    redirect_uri: redirectUri('instagram'),
    code,
  });
  const short = await api(`${GRAPH}/oauth/access_token?${params}`);
  // Short-lived tokens expire in about an hour; exchange immediately for the
  // 60-day token so a connected account survives longer than one sitting.
  const longParams = new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: process.env.META_APP_ID,
    client_secret: process.env.META_APP_SECRET,
    fb_exchange_token: short.access_token,
  });
  const long = await api(`${GRAPH}/oauth/access_token?${longParams}`);
  return {
    accessToken: long.access_token,
    expiresAt: long.expires_in
      ? new Date(Date.now() + long.expires_in * 1000).toISOString()
      : null,
  };
}

// One login -> every IG Professional account behind the Pages this user manages.
async function discover({ accessToken }) {
  const pages = await api(
    `${GRAPH}/me/accounts?fields=id,name,access_token,instagram_business_account{id,username,name,profile_picture_url}&limit=100&access_token=${accessToken}`,
  );
  const accounts = [];
  for (const page of pages.data || []) {
    const ig = page.instagram_business_account;
    if (!ig) continue;
    accounts.push({
      platformAccountId: ig.id,
      username: ig.username,
      displayName: ig.name || ig.username,
      avatarUrl: ig.profile_picture_url || '',
      // Page tokens do not expire while the user token is valid, and they are
      // what the publishing calls actually need.
      accessToken: page.access_token,
      meta: { pageId: page.id, pageName: page.name },
    });
  }
  return accounts;
}

function validate(post, media) {
  const problems = [];
  if (!media.length) problems.push('Instagram needs at least one photo or video.');
  if (post.caption.length > meta.limits.captionChars) {
    problems.push(`Caption is ${post.caption.length} characters; Instagram allows ${meta.limits.captionChars}.`);
  }
  const tags = (post.caption.match(/#[\w]+/g) || []).length;
  if (tags > meta.limits.hashtags) {
    problems.push(`${tags} hashtags; Instagram allows ${meta.limits.hashtags}.`);
  }
  if (media.length > 10) problems.push('A carousel can hold at most 10 items.');
  return problems;
}

async function publish({ account, tokens, caption, media, options }) {
  if (DRY_RUN) return simulatePublish('instagram', account);

  const igUserId = account.platformAccountId;
  const token = tokens.accessToken;
  const publicUrl = (m) => {
    const base = process.env.STUDIO_PUBLIC_URL;
    if (!base || base.includes('localhost')) {
      throw new PlatformError(
        'Instagram downloads media from a public URL. Set STUDIO_PUBLIC_URL to a reachable host (or an S3/CDN link) before publishing.',
      );
    }
    return `${base}${m.url}`;
  };

  async function createContainer(item, extra = {}) {
    const params = new URLSearchParams({ access_token: token, ...extra });
    if (item.kind === 'video') {
      params.set('media_type', options.asReel === false ? 'VIDEO' : 'REELS');
      params.set('video_url', publicUrl(item));
    } else {
      params.set('image_url', publicUrl(item));
    }
    const r = await api(`${GRAPH}/${igUserId}/media`, { method: 'POST', body: params });
    return r.id;
  }

  let creationId;
  if (media.length === 1) {
    creationId = await createContainer(media[0], { caption });
  } else {
    const children = [];
    for (const item of media) children.push(await createContainer(item, { is_carousel_item: 'true' }));
    const params = new URLSearchParams({
      access_token: token,
      media_type: 'CAROUSEL',
      children: children.join(','),
      caption,
    });
    const r = await api(`${GRAPH}/${igUserId}/media`, { method: 'POST', body: params });
    creationId = r.id;
  }

  await waitForContainer(creationId, token);

  const publishParams = new URLSearchParams({ access_token: token, creation_id: creationId });
  const published = await api(`${GRAPH}/${igUserId}/media_publish`, {
    method: 'POST',
    body: publishParams,
  });
  const permalink = await api(`${GRAPH}/${published.id}?fields=permalink&access_token=${token}`)
    .catch(() => ({}));
  return { remoteId: published.id, remoteUrl: permalink.permalink || null };
}

// Video containers are transcoded asynchronously; publishing before the
// container is FINISHED fails, so poll until Meta says it is ready.
async function waitForContainer(creationId, token, timeoutMs = 5 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await api(`${GRAPH}/${creationId}?fields=status_code,status&access_token=${token}`);
    if (r.status_code === 'FINISHED') return;
    if (r.status_code === 'ERROR' || r.status_code === 'EXPIRED') {
      throw new PlatformError(`Instagram rejected the upload: ${r.status || r.status_code}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new PlatformError('Instagram did not finish processing the media in time.', { retryable: true });
}

module.exports = { meta, authUrl, exchangeCode, discover, validate, publish };
