const store = require('./store');
const platforms = require('./platforms');

// Connections rot on their own schedule and nothing tells you until a post
// fails. Meta's long-lived tokens last about sixty days and cannot be renewed
// without the person signing in again; the rest carry refresh tokens and can be
// kept alive quietly. This sweep does both: renew what it can, and raise a flag
// well before the rest break.
// Deliberately narrow. The publisher already refreshes on demand ten minutes
// before it uses a token, so this sweep only needs to catch what would lapse
// unnoticed between sweeps. A wide window here would re-roll short-lived
// tokens every half hour — and TikTok rotates its refresh token on every use,
// so needless churn is a way to lose an account, not to protect one.
const RENEW_WITHIN_MS = Number(process.env.STUDIO_RENEW_WITHIN_MS || 15 * 60 * 1000);
const WARN_WITHIN_MS = Number(process.env.STUDIO_REAUTH_WARN_DAYS || 7) * 24 * 60 * 60 * 1000;

async function sweep() {
  const accounts = await store.listAccounts();
  const result = { renewed: 0, expiring: 0, failed: 0, checked: 0 };

  for (const summary of accounts) {
    const account = await store.getAccount(summary.id);
    if (!account || account.status === 'disconnected') continue;
    result.checked += 1;

    let adapter;
    try {
      adapter = platforms.get(account.platform);
    } catch {
      continue; // platform switched off; nothing to renew
    }

    const tokens = await store.accountTokens(account.id);
    if (!tokens) continue;

    const expiresAt = tokens.expiresAt ? new Date(tokens.expiresAt).getTime() : null;
    const until = expiresAt ? expiresAt - Date.now() : null;

    // Already dead.
    if (until !== null && until <= 0 && !tokens.refreshToken) {
      await store.setAccountStatus(account.id, 'needs_reauth',
        'The connection has expired. Send the creator a fresh invite link.');
      result.failed += 1;
      continue;
    }

    // Renewable and about to lapse — including one that already has, which is
    // recoverable so long as the refresh token still works.
    if (tokens.refreshToken && adapter.refresh && until !== null && until < RENEW_WITHIN_MS) {
      try {
        const next = await adapter.refresh(tokens.refreshToken);
        await store.saveAccountTokens(account.id, next);
        if (account.status !== 'connected') await store.setAccountStatus(account.id, 'connected', null);
        result.renewed += 1;
      } catch (err) {
        await store.setAccountStatus(account.id, 'needs_reauth',
          `Could not renew automatically: ${err.message}`);
        result.failed += 1;
      }
      continue;
    }

    // Not renewable and running out — this is the Meta case, and the only
    // useful thing to do is warn early enough that it can be fixed calmly.
    if (!tokens.refreshToken && until !== null && until < WARN_WITHIN_MS) {
      const days = Math.max(0, Math.round(until / 86400000));
      await store.setAccountStatus(account.id, 'expiring',
        `Expires in ${days} day${days === 1 ? '' : 's'} and cannot renew itself — send a fresh invite before then.`);
      result.expiring += 1;
    }
  }
  return result;
}

module.exports = { sweep, RENEW_WITHIN_MS, WARN_WITHIN_MS };
