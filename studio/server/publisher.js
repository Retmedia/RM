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

  // getMediaByIds quietly drops ids it cannot find. Left unsaid, that turns
  // into a post published with fewer files than intended, or none.
  if (media.length !== (post.mediaIds || []).length) {
    const missing = (post.mediaIds || []).length - media.length;
    problems.push({
      accountId: null,
      accountName: 'This post',
      platform: 'media',
      messages: [`${missing} file${missing === 1 ? ' is' : 's are'} missing from the library — re-upload before this goes out.`],
    });
  }
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

// A post a client has not signed off on never goes out, whichever path asks —
// the scheduler, the Publish button, or a bulk run.
function approvalBlock(post) {
  if (!post.approval?.required) return null;
  if (post.approval.status === 'approved') return null;
  return post.approval.status === 'changes_requested'
    ? 'The client asked for changes on this post.'
    : 'Waiting on client approval.';
}

// Only one publish run per post, ever, at a time.
//
// Without this, the scheduler tick and someone clicking Publish can both pick
// up the same due post, both read a target as pending, and both send it — two
// live posts on the client's account and one recorded here. A second caller
// joins the run already in flight rather than starting its own.
const inFlight = new Map();

// Publish every target that is still pending. One failing platform never stops
// the others — a TikTok rejection should not hold back the Instagram post.
function publishPost(postId) {
  const running = inFlight.get(postId);
  if (running) return running;
  const run = publishPostOnce(postId).finally(() => inFlight.delete(postId));
  inFlight.set(postId, run);
  return run;
}

async function publishPostOnce(postId) {
  const post = await store.getPost(postId);
  if (!post) return null;

  const blocked = approvalBlock(post);
  if (blocked) {
    post.status = 'awaiting_approval';
    await store.savePost(post);
    return post;
  }

  const media = await store.getMediaByIds(post.mediaIds);
  post.status = 'publishing';
  await store.savePost(post);

  for (const target of post.targets) {
    if (target.status === 'published') continue;
    if (target.nextAttemptAt && target.nextAttemptAt > new Date().toISOString()) continue;

    // Claim the target before any awaiting happens, so nothing else can read
    // it as still pending while this send is in the air.
    target.status = 'sending';
    await store.savePost(post);

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
  if (targets.some((t) => ['retrying', 'sending'].includes(t.status))) return 'publishing';
  if (targets.some((t) => t.status === 'published')) return 'partial';
  return 'failed';
}

module.exports = { publishPost, validatePost, rollupStatus, approvalBlock };
