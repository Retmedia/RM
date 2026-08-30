#!/usr/bin/env node
// Answers one question: can this go live right now, and if not, what is missing?
// Checks configuration and connected accounts, never sends anything.

const platforms = require('../server/platforms');
const store = require('../server/store');
const cadence = require('../server/cadence');

const CREDENTIALS = {
  instagram: ['META_APP_ID', 'META_APP_SECRET'],
  facebook: ['META_APP_ID', 'META_APP_SECRET'],
  tiktok: ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET'],
  x: ['X_CLIENT_ID', 'X_CLIENT_SECRET'],
  youtube: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
};

const blockers = [];
const warnings = [];
const ready = [];

function check(condition, message, list) {
  (condition ? ready : list).push(message);
  return condition;
}

(async function preflight() {
  const live = process.env.STUDIO_DRY_RUN === '0';
  const publicUrl = process.env.STUDIO_PUBLIC_URL || '';

  console.log(`\nRET Studio preflight — ${live ? 'LIVE' : 'dry run'}\n`);

  check(!!process.env.STUDIO_SECRET, 'STUDIO_SECRET is set, so stored tokens are encrypted', blockers);
  check(publicUrl.startsWith('https://'),
    `STUDIO_PUBLIC_URL is an https origin (currently ${publicUrl || 'unset'}) — OAuth callbacks and invite links need it`,
    live ? blockers : warnings);

  for (const meta of platforms.listMeta()) {
    const missing = (CREDENTIALS[meta.id] || []).filter((name) => !process.env[name]);
    check(missing.length === 0,
      `${meta.name}: set ${missing.join(' and ')}`,
      live ? blockers : warnings);
  }

  const creators = await store.listCreators();
  check(creators.length > 0, `${creators.length} creator(s) set up`, blockers);

  for (const creator of creators) {
    const connected = creator.accounts.filter((a) => a.status === 'connected');
    check(connected.length > 0, `${creator.name} has a connected account`, warnings);

    const stale = creator.accounts.filter((a) => a.status === 'needs_reauth');
    if (stale.length) warnings.push(`${creator.name}: ${stale.length} account(s) need reconnecting`);

    check(creator.slots?.length > 0, `${creator.name} has a posting rhythm`, warnings);
    check(cadence.isValidTimezone(creator.timezone),
      `${creator.name} has a valid timezone (${creator.timezone || 'unset'}) — slot times depend on it`,
      warnings);
  }

  const users = await store.listUsers();
  check(users.some((u) => u.role === 'owner' && !u.disabledAt), 'an active owner account exists', blockers);

  const posts = await store.listPosts();
  const needsCheck = posts.filter((p) => p.status === 'needs_check');
  if (needsCheck.length) {
    warnings.push(`${needsCheck.length} post(s) were interrupted mid-send and need checking`);
  }

  const show = (label, items, mark) => {
    if (!items.length) return;
    console.log(`${label}`);
    for (const item of items) console.log(`  ${mark} ${item}`);
    console.log('');
  };

  show('Ready', ready, '✓');
  show('Worth knowing', warnings, '!');
  show('Blocking', blockers, '✗');

  if (blockers.length) {
    console.log(`Not ready: ${blockers.length} blocker(s) above.\n`);
    process.exit(1);
  }
  console.log(live ? 'Ready to publish for real.\n' : 'Ready. Set STUDIO_DRY_RUN=0 when the platform approvals land.\n');
}());
