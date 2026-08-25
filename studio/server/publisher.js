const store = require('./store');
const platforms = require('./platforms');

const MAX_ATTEMPTS = 4;
// Backoff between attempts: a minute, five, twenty, an hour.
const BACKOFF_MINUTES = [1, 5, 20, 60];

// Refresh a token that is about to expire so a scheduled 6am post does not fail
// because nobody opened the app overnight.
async function freshTokens(account) {
  const tokens = await store.accountTokens(account.id);
  if (!tokens) throw new Error('Account has no stored credentials — reconnect it.');
  const adapter = platforms.get(account.platform);
  const expiresSoon = tokens.expiresAt && new Date(tokens.expiresAt).getTime() - Date.now() < 10 * 60 * 1000;
  if (!expiresSoon || !adapter.refresh || !tokens.refreshToken) return tokens;

  const next = await adapter.refresh(tokens.refreshToken);
  await store.saveAccountTokens(account.id, next);
  return next;
}

async function validatePost(post) {
  const media = await store.getMediaByIds(post.mediaIds);
  const problems = [];
  for (const target of post.targets) {
    const account = await store.getAccount(target.accountId);
    if (!account) {
      problems.push({ accountId: target.accountId, messages: ['This account is no longer connected.'] });
      continue;
    }
    const adapter = platforms.get(account.platform);
    const caption = target.captionOverride ?? post.caption;
    const messages = adapter.validate({ ...post, caption }, media);
    if (messages.length) {
      problems.push({ accountId: account.id, accountName: account.displayName, platform: account.platform, messages });
    }
  }
  return problems;
}

// Publish every target that is still pending. One failing platform never stops
// the others — a TikTok rejection should not hold back the Instagram post.
async function publishPost(postId) {
  const post = await store.getPost(postId);
  if (!post) return null;

  const media = await store.getMediaByIds(post.mediaIds);
  post.status = 'publishing';
  await store.savePost(post);

  for (const target of post.targets) {
    if (target.status === 'published') continue;
    if (target.nextAttemptAt && target.nextAttemptAt > new Date().toISOString()) continue;

    const account = await store.getAccount(target.accountId);
    if (!account) {
      target.status = 'failed';
      target.error = 'Account disconnected.';
      continue;
    }

    try {
      const adapter = platforms.get(account.platform);
      const tokens = await freshTokens(account);
      const caption = target.captionOverride ?? post.caption;
      const result = await adapter.publish({
        account,
        tokens,
        caption,
        media,
        options: target.options || {},
      });
      target.status = 'published';
      target.remoteId = result.remoteId;
      target.remoteUrl = result.remoteUrl;
      target.dryRun = !!result.dryRun;
      target.publishedAt = new Date().toISOString();
      target.error = null;
    } catch (err) {
      target.attempts += 1;
      target.error = err.message;
      if (err.needsReauth) {
        target.status = 'failed';
        await store.setAccountStatus(account.id, 'needs_reauth', err.message);
      } else if (err.retryable && target.attempts < MAX_ATTEMPTS) {
        target.status = 'retrying';
        const wait = BACKOFF_MINUTES[Math.min(target.attempts - 1, BACKOFF_MINUTES.length - 1)];
        target.nextAttemptAt = new Date(Date.now() + wait * 60 * 1000).toISOString();
      } else {
        target.status = 'failed';
      }
    }
  }

  post.status = rollupStatus(post.targets);
  await store.savePost(post);
  return post;
}

function rollupStatus(targets) {
  if (!targets.length) return 'draft';
  if (targets.every((t) => t.status === 'published')) return 'published';
  if (targets.some((t) => t.status === 'retrying')) return 'publishing';
  if (targets.some((t) => t.status === 'published')) return 'partial';
  return 'failed';
}

module.exports = { publishPost, validatePost, rollupStatus };
