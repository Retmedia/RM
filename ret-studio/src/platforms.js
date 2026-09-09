// One source of truth for the four destinations Cadent posts to.
// `sub` is the line the creator reads on the grant page, so keep it plain.
export const PLATFORMS = [
  {
    id: 'youtube',
    name: 'YouTube',
    sub: 'Shorts and full uploads to your channel',
    color: '#FF0033',
    // Google will only ever hand us the channel of the account that taps Allow.
    ownerOnly: true,
    envKeys: ['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET'],
    liveKey: 'YOUTUBE_LIVE',
    review: 'Google OAuth verification'
  },
  {
    id: 'tiktok',
    name: 'TikTok',
    sub: 'Posts straight to your account',
    color: '#FE2C55',
    envKeys: ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET'],
    liveKey: 'TIKTOK_LIVE',
    review: 'TikTok app audit'
  },
  {
    id: 'facebook',
    name: 'Facebook',
    sub: 'Reels on your Page',
    color: '#1877F2',
    envKeys: ['META_APP_ID', 'META_APP_SECRET'],
    liveKey: 'META_LIVE',
    review: 'Meta App Review'
  },
  {
    id: 'instagram',
    name: 'Instagram',
    sub: 'Reels on your professional account',
    color: '#C13584',
    envKeys: ['META_APP_ID', 'META_APP_SECRET'],
    liveKey: 'META_LIVE',
    review: 'Meta App Review'
  }
];

export const PLATFORM_IDS = PLATFORMS.map((p) => p.id);
export const byId = (id) => PLATFORMS.find((p) => p.id === id) || null;

// A platform is live only when its app credentials exist AND its review has landed.
// Anything short of that stays on Test connect, and the UI says so out loud.
export function liveState(env = process.env) {
  const out = {};
  for (const p of PLATFORMS) {
    const configured = p.envKeys.every((k) => Boolean(env[k] && String(env[k]).trim()));
    const approved = String(env[p.liveKey] || '') === '1';
    out[p.id] = {
      configured,
      approved,
      live: configured && approved,
      review: p.review,
      missing: p.envKeys.filter((k) => !env[k] || !String(env[k]).trim())
    };
  }
  return out;
}
