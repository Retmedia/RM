const store = require('./store');
const platforms = require('./platforms');

// Metrics are pulled per published target and cached on the target, so the
// performance screen never fans out API calls while someone is looking at it.
// Refresh cadence is deliberately slow: a post's numbers matter over days.
const REFRESH_AFTER_MS = 6 * 60 * 60 * 1000;

async function refreshPost(post, { force = false } = {}) {
  let touched = false;
  for (const target of post.targets) {
    if (target.status !== 'published' || !target.remoteId || target.dryRun) continue;
    const fresh = target.metricsAt && Date.now() - new Date(target.metricsAt).getTime() < REFRESH_AFTER_MS;
    if (fresh && !force) continue;

    const account = await store.getAccount(target.accountId);
    if (!account) continue;

    try {
      const adapter = platforms.get(account.platform);
      if (!adapter.fetchMetrics) continue;
      const tokens = await store.accountTokens(account.id);
      const metrics = await adapter.fetchMetrics({ account, tokens, remoteId: target.remoteId });
      if (metrics) {
        target.metrics = metrics;
        target.metricsAt = new Date().toISOString();
        target.metricsError = null;
        touched = true;
      }
    } catch (err) {
      // A metrics failure is never allowed to look like a publish failure.
      target.metricsError = err.message;
      touched = true;
    }
  }
  if (touched) await store.savePost(post);
  return post;
}

async function refreshAll({ force = false, limit = 60 } = {}) {
  const posts = await store.listPosts();
  const published = posts
    .filter((p) => p.targets.some((t) => t.status === 'published' && !t.dryRun))
    .slice(-limit);
  for (const post of published) await refreshPost(post, { force });
  return published.length;
}

// Rolls the per-target numbers up per creator and per account, which is the
// shape a client conversation actually needs.
async function summary({ since } = {}) {
  const posts = await store.listPosts();
  const creators = await store.listCreators();
  const accounts = await store.listAccounts();
  const cutoff = since ? new Date(since).toISOString() : null;

  const blank = () => ({ posts: 0, views: 0, likes: 0, comments: 0, shares: 0, withData: 0 });
  const byCreator = new Map(creators.map((c) => [c.id, { creator: c, ...blank() }]));
  const byAccount = new Map(accounts.map((a) => [a.id, { account: a, ...blank() }]));
  const top = [];

  for (const post of posts) {
    if (cutoff && post.scheduledAt && post.scheduledAt < cutoff) continue;
    for (const target of post.targets) {
      if (target.status !== 'published') continue;
      const creatorRow = byCreator.get(post.creatorId);
      const accountRow = byAccount.get(target.accountId);
      const m = target.metrics;
      for (const row of [creatorRow, accountRow]) {
        if (!row) continue;
        row.posts += 1;
        if (!m) continue;
        row.withData += 1;
        row.views += m.views || 0;
        row.likes += m.likes || 0;
        row.comments += m.comments || 0;
        row.shares += m.shares || 0;
      }
      if (m && m.views) {
        top.push({
          postId: post.id,
          creatorId: post.creatorId,
          accountId: target.accountId,
          caption: post.caption.split('\n')[0].slice(0, 80),
          publishedAt: target.publishedAt,
          remoteUrl: target.remoteUrl,
          ...m,
        });
      }
    }
  }

  top.sort((a, b) => (b.views || 0) - (a.views || 0));
  return {
    creators: [...byCreator.values()],
    accounts: [...byAccount.values()].filter((r) => r.posts > 0),
    top: top.slice(0, 20),
    // Says plainly when there is nothing real to show, rather than rendering
    // a page of zeroes that reads like poor performance.
    hasData: top.length > 0,
  };
}

module.exports = { refreshPost, refreshAll, summary };
