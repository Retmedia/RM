const store = require('./store');
const { publishPost } = require('./publisher');

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
      if (p.status === 'scheduled') return true;
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

function start() {
  if (timer) return;
  timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  tick();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, tick, log };
