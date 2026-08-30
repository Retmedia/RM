const store = require('./store');
const { publishPost, approvalBlock } = require('./publisher');

const TICK_MS = Number(process.env.STUDIO_TICK_MS) || 30_000;

let timer = null;
let running = false;
const log = [];

function record(entry) {
  log.unshift({ at: new Date().toISOString(), ...entry });
  log.length = Math.min(log.length, 100);
}

async function tick() {
  if (running) return;
  running = true;
  try {
    const now = new Date().toISOString();
    const posts = await store.listPosts();
    const due = posts.filter((p) => {
      if (!p.scheduledAt || p.scheduledAt > now) return false;
      // Leave unapproved posts sitting in the queue rather than burning a
      // publish attempt on them every tick.
      if (approvalBlock(p)) return false;
      // Both are "queued and now allowed": a plain scheduled post, and one that
      // was held for approval and has since been approved.
      if (p.status === 'scheduled' || p.status === 'awaiting_approval') return true;
      // Pick a post back up once its backoff window has passed.
      if (p.status === 'publishing' || p.status === 'partial') {
        return p.targets.some((t) => t.status === 'retrying' && (!t.nextAttemptAt || t.nextAttemptAt <= now));
      }
      return false;
    });
    for (const post of due) {
      const result = await publishPost(post.id);
      record({
        postId: post.id,
        status: result.status,
        targets: result.targets.map((t) => ({ accountId: t.accountId, status: t.status, error: t.error })),
      });
    }
  } catch (err) {
    record({ error: err.message });
  } finally {
    running = false;
  }
}

// A target left mid-send by a crash is genuinely ambiguous: it may or may not
// have reached the platform. Retrying could double-post and dropping it could
// lose the post, so it is surfaced for a person to check rather than guessed at.
async function recoverInterrupted() {
  const posts = await store.listPosts();
  let found = 0;
  for (const post of posts) {
    let touched = false;
    for (const target of post.targets) {
      if (target.status !== 'sending') continue;
      target.status = 'unknown';
      target.error = 'Interrupted mid-send by a restart. Check the account before retrying — it may already be live.';
      touched = true;
      found += 1;
    }
    if (touched) {
      post.status = 'needs_check';
      await store.savePost(post);
    }
  }
  if (found) {
    record({ recovered: found });
    console.warn(`WARNING  ${found} post target(s) were interrupted mid-send and need checking.`);
  }
  return found;
}

function start() {
  if (timer) return;
  recoverInterrupted().catch((err) => record({ error: err.message }));
  timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  tick();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, tick, log, recoverInterrupted };
