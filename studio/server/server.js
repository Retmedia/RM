const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const store = require('./store');
const platforms = require('./platforms');
const connect = require('./connect');
const scheduler = require('./scheduler');
const insights = require('./insights');
const cadence = require('./cadence');
const { publishPost, validatePost } = require('./publisher');

const port = Number(process.env.PORT) || 4400;

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/media', express.static(store.MEDIA_DIR));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    dryRun: process.env.STUDIO_DRY_RUN !== '0',
    encryptedTokens: !!process.env.STUDIO_SECRET,
    data: store.DATA_ROOT,
  });
});

app.get('/api/platforms', (_req, res) => res.json(platforms.listMeta()));

// Accounts can outlive a platform being switched off, so the UI needs to know
// which ones it can still act on.
app.get('/api/platforms/all', (_req, res) => {
  res.json(Object.keys(platforms.platforms).map((id) => platforms.describe(id)));
});

/* ---------------------------------------------------------------- creators */

app.get('/api/creators', wrap(async (_req, res) => res.json(await store.listCreators())));

app.post('/api/creators', wrap(async (req, res) => {
  const { name } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
  res.json(await store.createCreator(req.body));
}));

app.patch('/api/creators/:id', wrap(async (req, res) => {
  const creator = await store.updateCreator(req.params.id, req.body || {});
  if (!creator) return res.status(404).json({ error: 'not found' });
  res.json(creator);
}));

app.delete('/api/creators/:id', wrap(async (req, res) => {
  res.json({ ok: await store.deleteCreator(req.params.id) });
}));

/* ---------------------------------------------------------------- accounts */

app.get('/api/accounts', wrap(async (_req, res) => res.json(await store.listAccounts())));

app.patch('/api/accounts/:id', wrap(async (req, res) => {
  const { creatorId } = req.body || {};
  const account = await store.reassignAccount(req.params.id, creatorId);
  if (!account) return res.status(404).json({ error: 'not found' });
  res.json(account);
}));

app.delete('/api/accounts/:id', wrap(async (req, res) => {
  res.json({ ok: await store.disconnectAccount(req.params.id) });
}));

app.post('/api/accounts/demo', wrap(async (req, res) => {
  const { platform, creatorId, displayName, username } = req.body || {};
  if (!platform || !username) return res.status(400).json({ error: 'platform and username are required' });
  res.json(await connect.connectDemoAccount({ platform, creatorId, displayName, username }));
}));

/* ------------------------------------------------------------------- oauth */

app.post('/api/connect/:platform', wrap(async (req, res) => {
  const { creatorId } = req.body || {};
  try {
    res.json(connect.beginConnect({ platform: req.params.platform, creatorId }));
  } catch (err) {
    // A missing app credential is a setup problem, not a server fault — say so
    // plainly instead of returning a 500.
    res.status(400).json({ error: err.message });
  }
}));

app.get('/auth/:platform/callback', wrap(async (req, res) => {
  const { code, state, error, error_description: description } = req.query;
  if (error) return res.redirect(`/#connect?error=${encodeURIComponent(description || error)}`);
  try {
    const accounts = await connect.completeConnect({
      platform: req.params.platform,
      code: String(code),
      state: String(state),
    });
    res.redirect(`/#connect?connected=${accounts.length}`);
  } catch (err) {
    res.redirect(`/#connect?error=${encodeURIComponent(err.message)}`);
  }
}));

/* ------------------------------------------------------------------- media */

const EXT = { 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

// Raw-body upload: the browser sends the File itself with the name in a header,
// which avoids a multipart dependency for what is always a single file.
app.post('/api/media', express.raw({ type: '*/*', limit: '600mb' }), wrap(async (req, res) => {
  const filename = req.get('x-filename');
  const mimeType = req.get('content-type') || 'application/octet-stream';
  if (!filename) return res.status(400).json({ error: 'x-filename header is required' });
  if (!req.body || !req.body.length) return res.status(400).json({ error: 'empty upload' });
  if (!EXT[mimeType]) return res.status(415).json({ error: `Unsupported media type: ${mimeType}` });

  const storedName = `${crypto.randomBytes(8).toString('hex')}${EXT[mimeType]}`;
  fs.writeFileSync(path.join(store.MEDIA_DIR, storedName), req.body);
  res.json(await store.addMedia({
    filename,
    storedName,
    mimeType,
    size: req.body.length,
    kind: mimeType.startsWith('video/') ? 'video' : 'image',
  }));
}));

app.get('/api/media', wrap(async (_req, res) => res.json(await store.listMedia())));

/* ------------------------------------------------------------------- posts */

app.get('/api/posts', wrap(async (req, res) => {
  res.json(await store.listPosts({
    from: req.query.from,
    to: req.query.to,
    creatorId: req.query.creatorId,
    status: req.query.status,
  }));
}));

app.post('/api/posts', wrap(async (req, res) => {
  const { creatorId, targets } = req.body || {};
  if (!creatorId) return res.status(400).json({ error: 'creatorId is required' });
  if (!Array.isArray(targets) || !targets.length) {
    return res.status(400).json({ error: 'pick at least one account to post to' });
  }
  res.json(await store.createPost(req.body));
}));

app.patch('/api/posts/:id', wrap(async (req, res) => {
  const post = await store.updatePost(req.params.id, req.body || {});
  if (!post) return res.status(404).json({ error: 'not found' });
  res.json(post);
}));

app.delete('/api/posts/:id', wrap(async (req, res) => {
  res.json({ ok: await store.deletePost(req.params.id) });
}));

// The volume path: hand it a pile of media and it becomes one post per file,
// dropped into that creator's next open slots.
app.post('/api/posts/bulk', wrap(async (req, res) => {
  const { creatorId, mediaIds, captions, targets, startAt } = req.body || {};
  if (!creatorId) return res.status(400).json({ error: 'creatorId is required' });
  if (!Array.isArray(mediaIds) || !mediaIds.length) {
    return res.status(400).json({ error: 'pick at least one file' });
  }

  const creators = await store.listCreators();
  const creator = creators.find((c) => c.id === creatorId);
  if (!creator) return res.status(404).json({ error: 'creator not found' });
  if (!creator.slots?.length) {
    return res.status(400).json({ error: `${creator.name} has no posting rhythm set — add one under Creators.` });
  }

  const chosen = Array.isArray(targets) && targets.length
    ? targets
    : creator.accounts.filter((a) => a.status === 'connected').map((a) => ({ accountId: a.id }));
  if (!chosen.length) return res.status(400).json({ error: 'no connected accounts to post to' });

  const existing = (await store.listPosts({ creatorId }))
    .filter((p) => p.scheduledAt && p.status !== 'published')
    .map((p) => p.scheduledAt);

  const when = cadence.nextOpenSlots({
    slots: creator.slots,
    count: mediaIds.length,
    taken: existing,
    from: startAt ? new Date(startAt) : new Date(),
  });
  if (when.length < mediaIds.length) {
    return res.status(400).json({ error: 'Not enough open slots in the next 18 months for that many posts.' });
  }

  const created = [];
  for (let i = 0; i < mediaIds.length; i += 1) {
    created.push(await store.createPost({
      creatorId,
      caption: (captions && captions[i]) || '',
      mediaIds: [mediaIds[i]],
      scheduledAt: when[i],
      status: 'scheduled',
      targets: chosen,
    }));
  }
  res.json({ created: created.length, first: created[0], last: created[created.length - 1], posts: created });
}));

// Lets the composer show where a bulk drop would land before committing to it.
app.get('/api/creators/:id/slots/preview', wrap(async (req, res) => {
  const creators = await store.listCreators();
  const creator = creators.find((c) => c.id === req.params.id);
  if (!creator) return res.status(404).json({ error: 'not found' });
  const count = Math.min(Number(req.query.count) || 5, 200);
  const existing = (await store.listPosts({ creatorId: creator.id }))
    .filter((p) => p.scheduledAt && p.status !== 'published')
    .map((p) => p.scheduledAt);
  res.json({
    rhythm: cadence.describe(creator.slots),
    slots: cadence.nextOpenSlots({ slots: creator.slots, count, taken: existing }),
  });
}));

app.post('/api/posts/:id/validate', wrap(async (req, res) => {
  const post = await store.getPost(req.params.id);
  if (!post) return res.status(404).json({ error: 'not found' });
  res.json({ problems: await validatePost(post) });
}));

app.post('/api/posts/:id/publish', wrap(async (req, res) => {
  const post = await store.getPost(req.params.id);
  if (!post) return res.status(404).json({ error: 'not found' });
  const problems = await validatePost(post);
  if (problems.length && !req.body?.force) return res.status(400).json({ problems });
  res.json(await publishPost(post.id));
}));

/* --------------------------------------------------------------- approvals */

// Opening (or re-opening) review mints a fresh link, so an edited post can
// never be waved through by a link the client saw before the edit.
app.post('/api/posts/:id/review', wrap(async (req, res) => {
  const post = await store.resetApproval(req.params.id, req.body?.required !== false);
  if (!post) return res.status(404).json({ error: 'not found' });
  res.json({
    post,
    link: post.approval.token
      ? `${process.env.STUDIO_PUBLIC_URL || `http://localhost:${port}`}/review/${post.approval.token}`
      : null,
  });
}));

// Everything below is what a client touches. No account, no session — the
// token in the link is the whole of the authorisation, and it reaches exactly
// one post.
app.get('/review/:token', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'review.html'));
});

app.get('/api/review/:token', wrap(async (req, res) => {
  const post = await store.getPostByToken(req.params.token);
  if (!post) return res.status(404).json({ error: 'This review link is no longer valid.' });
  const creators = await store.listCreators();
  const creator = creators.find((c) => c.id === post.creatorId);
  const media = await store.getMediaByIds(post.mediaIds);
  const accounts = await store.listAccounts();
  res.json({
    creator: creator ? { name: creator.name, color: creator.color } : null,
    caption: post.caption,
    scheduledAt: post.scheduledAt,
    approval: { status: post.approval.status, note: post.approval.note, reviewedAt: post.approval.reviewedAt },
    media: media.map((m) => ({ url: m.url, kind: m.kind })),
    destinations: post.targets.map((t) => {
      const account = accounts.find((a) => a.id === t.accountId);
      return { platform: account?.platform || 'unknown', name: account?.displayName || 'Account' };
    }),
  });
}));

app.post('/api/review/:token', wrap(async (req, res) => {
  const post = await store.getPostByToken(req.params.token);
  if (!post) return res.status(404).json({ error: 'This review link is no longer valid.' });
  const { decision, note, name } = req.body || {};
  if (decision === 'changes_requested' && !String(note || '').trim()) {
    return res.status(400).json({ error: 'Tell us what to change so we can fix it.' });
  }
  const updated = await store.recordReview(post.id, { decision, note, reviewedBy: name });
  if (!updated) return res.status(400).json({ error: 'Choose approve or request changes.' });
  res.json({ status: updated.approval.status });
}));

/* ---------------------------------------------------------------- insights */

app.get('/api/insights', wrap(async (req, res) => res.json(await insights.summary({ since: req.query.since }))));

app.post('/api/insights/refresh', wrap(async (_req, res) => {
  res.json({ refreshed: await insights.refreshAll({ force: true }) });
}));

app.get('/api/scheduler', (_req, res) => res.json({ log: scheduler.log }));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

store.load().then(() => {
  scheduler.start();
  app.listen(port, '127.0.0.1', () => {
    console.log(`RET Studio on http://localhost:${port}`);
    console.log(`Data: ${store.DATA_ROOT}`);
    if (process.env.STUDIO_DRY_RUN !== '0') {
      console.log('DRY RUN — posts are simulated, nothing is sent to any platform.');
    }
  });
});

module.exports = app;
