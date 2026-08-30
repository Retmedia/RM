const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const store = require('./store');
const auth = require('./auth');
const platforms = require('./platforms');
const connect = require('./connect');
const scheduler = require('./scheduler');
const insights = require('./insights');
const cadence = require('./cadence');
const { publishPost, validatePost } = require('./publisher');

const port = Number(process.env.PORT) || 4400;

const app = express();

// Behind a reverse proxy (which is how this gets a public HTTPS origin), trust
// the forwarding headers so req.protocol and the client IP are the real ones.
if (process.env.STUDIO_TRUST_PROXY !== '0') app.set('trust proxy', 1);

app.use(express.json({ limit: '2mb' }));

// Media has to stay reachable without a session: Meta fetches Instagram media
// by URL, and clients open review links without an account. Stored names are
// 64 bits of randomness, which is what keeps them private.
app.use('/media', express.static(store.MEDIA_DIR, { maxAge: '1h' }));

app.use(auth.attachUser());

// Default-deny. Everything under /api needs a session unless it is on this
// list, so a route added later is protected by omission rather than exposed
// by it. The public ones are all either pre-auth or authorised by a token in
// the URL that reaches exactly one record.
const PUBLIC_API = [
  { method: 'GET', pattern: /^\/api\/session$/ },
  { method: 'POST', pattern: /^\/api\/session$/ },
  { method: 'DELETE', pattern: /^\/api\/session$/ },
  { method: 'POST', pattern: /^\/api\/setup$/ },
  { method: 'GET', pattern: /^\/api\/health$/ },
  { method: 'GET', pattern: /^\/api\/review\/[^/]+$/ },
  { method: 'POST', pattern: /^\/api\/review\/[^/]+$/ },
  { method: 'GET', pattern: /^\/api\/invite\/[^/]+$/ },
  { method: 'POST', pattern: /^\/api\/invite\/[^/]+\/connect\/[^/]+$/ },
];

app.use('/api', (req, res, next) => {
  const full = `/api${req.path === '/' ? '' : req.path}`;
  const open = PUBLIC_API.some((r) => r.method === req.method && r.pattern.test(full));
  if (open || req.user) return next();
  res.status(401).json({ error: 'Sign in to continue.' });
});

// A crude but sufficient throttle on the endpoints a stranger can reach:
// sign-in, and the token-bearing public pages. Counts per IP per window.
const attempts = new Map();
function throttle({ max, windowMs, keyBy }) {
  return (req, res, next) => {
    const now = Date.now();
    const key = `${req.method}:${req.baseUrl}${req.path}:${req.ip}:${keyBy ? keyBy(req) : ''}`;
    const hits = (attempts.get(key) || []).filter((t) => now - t < windowMs);
    if (hits.length >= max) {
      res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
      return res.status(429).json({ error: 'Too many attempts. Wait a minute and try again.' });
    }
    hits.push(now);
    attempts.set(key, hits);
    // Keep the map from growing without bound on a long-running process.
    if (attempts.size > 5000) {
      for (const [k, v] of attempts) if (!v.some((t) => now - t < windowMs)) attempts.delete(k);
    }
    next();
  };
}

// Keyed on the email being tried, not just the IP: brute-forcing one account
// is the actual threat, and an office where everyone shares an address should
// not lock itself out because one person fumbled their password.
const loginLimiter = throttle({
  max: Number(process.env.STUDIO_LOGIN_ATTEMPTS || 20),
  windowMs: 15 * 60 * 1000,
  keyBy: (req) => String(req.body?.email || '').trim().toLowerCase(),
});

const tokenLimiter = throttle({ max: 120, windowMs: 15 * 60 * 1000 });

// Pages are static; every one of them calls an API that enforces its own
// access, so serving the HTML shell needs no guard.
app.use(express.static(path.join(__dirname, '..', 'public')));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    dryRun: process.env.STUDIO_DRY_RUN !== '0',
    encryptedTokens: !!process.env.STUDIO_SECRET,
    data: store.DATA_ROOT,
  });
});

/* -------------------------------------------------------------------- auth */

// Says whether anyone exists yet, so the login screen can offer to create the
// first owner instead of asking for credentials that cannot exist.
app.get('/api/session', wrap(async (req, res) => {
  res.json({ user: req.user || null, needsSetup: (await store.countUsers()) === 0 });
}));

app.post('/api/session', loginLimiter, wrap(async (req, res) => {
  const { email, password } = req.body || {};
  const result = await auth.login({ email, password, userAgent: req.get('user-agent') });
  if (!result) return res.status(401).json({ error: 'That email and password do not match.' });
  auth.setSessionCookie(res, result.token, { secure: auth.isSecureRequest(req) });
  res.json({ user: result.user });
}));

app.delete('/api/session', wrap(async (req, res) => {
  await auth.logout(req.sessionToken);
  auth.clearSessionCookie(res);
  res.json({ ok: true });
}));

// First run only. Once an owner exists this closes permanently, so the setup
// screen can never be used to mint a second admin.
app.post('/api/setup', wrap(async (req, res) => {
  if ((await store.countUsers()) > 0) {
    return res.status(409).json({ error: 'This studio is already set up. Sign in instead.' });
  }
  const { email, name, password } = req.body || {};
  if (!email || !String(email).includes('@')) return res.status(400).json({ error: 'Enter a real email address.' });
  const weak = auth.passwordProblem(password);
  if (weak) return res.status(400).json({ error: weak });

  const user = await store.createUser({
    email, name, role: 'owner', passwordHash: auth.hashPassword(password),
  });
  const result = await auth.login({ email, password, userAgent: req.get('user-agent') });
  auth.setSessionCookie(res, result.token, { secure: auth.isSecureRequest(req) });
  res.json({ user });
}));

/* ------------------------------------------------------------------- team */

app.get('/api/users', wrap(async (_req, res) => res.json(await store.listUsers())));

app.post('/api/users', auth.requireOwner, wrap(async (req, res) => {
  const { email, name, role, password } = req.body || {};
  if (!email || !String(email).includes('@')) return res.status(400).json({ error: 'Enter a real email address.' });
  const weak = auth.passwordProblem(password);
  if (weak) return res.status(400).json({ error: weak });
  try {
    res.json(await store.createUser({ email, name, role, passwordHash: auth.hashPassword(password) }));
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
}));

app.patch('/api/users/:id', wrap(async (req, res) => {
  const { name, role, password, disabled } = req.body || {};
  const self = req.user.id === req.params.id;
  // Anyone can rename themselves or change their own password. Only an owner
  // can change roles or switch someone off, and never their own — otherwise
  // the last owner can lock the studio out of itself.
  if ((role !== undefined || disabled !== undefined)) {
    if (req.user.role !== 'owner') return res.status(403).json({ error: 'Only an owner can do that.' });
    if (self) return res.status(400).json({ error: 'You cannot change your own role or access.' });
  }
  if (!self && name === undefined && role === undefined && disabled === undefined) {
    return res.status(403).json({ error: 'You can only change your own details.' });
  }
  if (password !== undefined && !self) {
    return res.status(403).json({ error: 'People set their own passwords.' });
  }
  const patch = { name, role, disabled };
  if (password !== undefined) {
    const weak = auth.passwordProblem(password);
    if (weak) return res.status(400).json({ error: weak });
    patch.passwordHash = auth.hashPassword(password);
  }
  const user = await store.updateUser(req.params.id, patch);
  if (!user) return res.status(404).json({ error: 'not found' });
  res.json(user);
}));

app.delete('/api/users/:id', auth.requireOwner, wrap(async (req, res) => {
  if (req.user.id === req.params.id) return res.status(400).json({ error: 'You cannot remove yourself.' });
  const owners = (await store.listUsers()).filter((u) => u.role === 'owner' && !u.disabledAt);
  const target = await store.getUser(req.params.id);
  if (target?.role === 'owner' && owners.length <= 1) {
    return res.status(400).json({ error: 'That is the last owner — promote someone else first.' });
  }
  res.json({ ok: await store.deleteUser(req.params.id) });
}));

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

app.delete('/api/creators/:id', auth.requireOwner, wrap(async (req, res) => {
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

// One callback serves both paths. Where the handshake started decides where the
// browser lands: the agency's own screen, or the creator's invite page.
app.get('/auth/:platform/callback', wrap(async (req, res) => {
  const { code, state, error, error_description: description } = req.query;
  const started = connect.peekState(String(state || ''));
  const home = started?.inviteToken ? `/invite/${started.inviteToken}` : '/#connect';
  const sep = home.includes('#') ? '?' : '#';

  if (error) return res.redirect(`${home}${sep}error=${encodeURIComponent(description || error)}`);
  try {
    const accounts = await connect.completeConnect({
      platform: req.params.platform,
      code: String(code),
      state: String(state),
    });
    res.redirect(`${home}${sep}connected=${encodeURIComponent(accounts.map((a) => a.displayName).join(', '))}`);
  } catch (err) {
    res.redirect(`${home}${sep}error=${encodeURIComponent(err.message)}`);
  }
}));

/* ----------------------------------------------------------------- invites */

// The answer to a client who will not make you an Owner: they never have to.
// They open this link, authorise with the account that already owns the
// channel, and the token that comes back can post. Their role never changes.
app.post('/api/invites', wrap(async (req, res) => {
  const { creatorId, platforms: wanted, note, expiresInDays } = req.body || {};
  if (!creatorId) return res.status(400).json({ error: 'creatorId is required' });
  const list = (Array.isArray(wanted) && wanted.length ? wanted : platforms.enabled)
    .filter((id) => platforms.isEnabled(id));
  if (!list.length) return res.status(400).json({ error: 'pick at least one platform' });

  const invite = await store.createInvite({ creatorId, platforms: list, note, expiresInDays });
  res.json({ invite, link: inviteLink(invite.token) });
}));

app.get('/api/invites', wrap(async (_req, res) => {
  const invites = await store.listInvites();
  res.json(invites.map((i) => ({ ...i, link: inviteLink(i.token) })));
}));

app.delete('/api/invites/:id', wrap(async (req, res) => {
  res.json({ ok: await store.revokeInvite(req.params.id) });
}));

function inviteLink(token) {
  return `${process.env.STUDIO_PUBLIC_URL || `http://localhost:${port}`}/invite/${token}`;
}

app.get('/invite/:token', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'invite.html'));
});

app.get('/api/invite/:token', tokenLimiter, wrap(async (req, res) => {
  const invite = await store.getInviteByToken(req.params.token);
  const problem = store.inviteProblem(invite);
  if (problem) return res.status(404).json({ error: problem });

  const creators = await store.listCreators();
  const creator = creators.find((c) => c.id === invite.creatorId);
  res.json({
    creator: creator ? { name: creator.name } : null,
    note: invite.note,
    platforms: invite.platforms.map((id) => {
      const meta = platforms.describe(id);
      return {
        id,
        name: meta.name,
        color: meta.color,
        // What the creator is actually agreeing to, in their words not ours.
        asks: meta.requirements,
        connected: invite.connected.find((c) => c.platform === id) || null,
      };
    }),
  });
}));

app.post('/api/invite/:token/connect/:platform', tokenLimiter, wrap(async (req, res) => {
  const invite = await store.getInviteByToken(req.params.token);
  const problem = store.inviteProblem(invite);
  if (problem) return res.status(404).json({ error: problem });
  if (!invite.platforms.includes(req.params.platform)) {
    return res.status(400).json({ error: 'That platform is not part of this link.' });
  }
  try {
    const { url } = connect.beginConnect({
      platform: req.params.platform,
      creatorId: invite.creatorId,
      inviteId: invite.id,
      inviteToken: invite.token,
    });
    res.json({ url });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

/* ------------------------------------------------------------------- media */

const EXT = { 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

// Raw-body upload: the browser sends the File itself with the name in a header,
// which avoids a multipart dependency for what is always a single file.
//
// Streamed to disk rather than buffered. A month of Blair's clips is sixty
// files at 70-200MB each; holding any one of them in memory is how this falls
// over on the machine it actually runs on.
const MAX_UPLOAD_BYTES = Number(process.env.STUDIO_MAX_UPLOAD_MB || 2048) * 1024 * 1024;

app.post('/api/media', wrap(async (req, res) => {
  const filename = req.get('x-filename');
  const mimeType = (req.get('content-type') || '').split(';')[0].trim();
  if (!filename) return res.status(400).json({ error: 'x-filename header is required' });
  if (!EXT[mimeType]) return res.status(415).json({ error: `Unsupported media type: ${mimeType || 'unknown'}` });

  const declared = Number(req.get('content-length') || 0);
  if (declared && declared > MAX_UPLOAD_BYTES) {
    return res.status(413).json({ error: `That file is larger than the ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB limit.` });
  }

  const storedName = `${crypto.randomBytes(8).toString('hex')}${EXT[mimeType]}`;
  const target = path.join(store.MEDIA_DIR, storedName);
  const sink = fs.createWriteStream(target);
  let written = 0;
  let failed = null;

  try {
    await new Promise((resolve, reject) => {
      req.on('data', (chunk) => {
        written += chunk.length;
        if (written > MAX_UPLOAD_BYTES) {
          failed = `That file is larger than the ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB limit.`;
          req.destroy();
        }
      });
      req.on('error', reject);
      sink.on('error', reject);
      sink.on('finish', resolve);
      req.pipe(sink);
    });
  } catch (err) {
    // A half-written file is worse than none — it would look like valid media
    // and fail at publish time instead of here.
    await fs.promises.rm(target, { force: true });
    if (failed) return res.status(413).json({ error: failed });
    throw err;
  }

  if (failed) {
    await fs.promises.rm(target, { force: true });
    return res.status(413).json({ error: failed });
  }
  if (!written) {
    await fs.promises.rm(target, { force: true });
    return res.status(400).json({ error: 'That upload was empty.' });
  }

  res.json(await store.addMedia({
    filename,
    storedName,
    mimeType,
    size: written,
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
    timezone: creator.timezone,
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
    timezone: creator.timezone || cadence.DEFAULT_TZ,
    slots: cadence.nextOpenSlots({
      slots: creator.slots, count, taken: existing, timezone: creator.timezone,
    }),
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

app.get('/api/review/:token', tokenLimiter, wrap(async (req, res) => {
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

app.post('/api/review/:token', tokenLimiter, wrap(async (req, res) => {
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

// An unexpected error is logged in full but never described to the caller:
// messages here carry file paths, environment variable names and library
// internals, none of which a browser needs and some of which help an attacker.
app.use((err, req, res, _next) => {
  const ref = crypto.randomBytes(4).toString('hex');
  console.error(`[${ref}] ${req.method} ${req.originalUrl}`, err);
  res.status(500).json({
    error: 'Something went wrong on our side. Nothing was published.',
    reference: ref,
  });
});

// Localhost by default so a development run is not accidentally exposed.
// A real deployment sets STUDIO_HOST=0.0.0.0 and puts HTTPS in front.
const host = process.env.STUDIO_HOST || '127.0.0.1';

// Anything that would be unsafe once real credentials are in play stops the
// process rather than printing a line nobody reads.
function refuseToStart() {
  const live = process.env.STUDIO_DRY_RUN === '0';
  if (live && !process.env.STUDIO_SECRET) {
    return 'STUDIO_SECRET must be set before live publishing — without it, every platform '
      + 'refresh token is written to disk in plain text. Generate one with: openssl rand -hex 32';
  }
  return null;
}

function startupWarnings() {
  const warnings = [];
  if (!process.env.STUDIO_SECRET) {
    warnings.push('STUDIO_SECRET is not set — platform tokens are being stored unencrypted. Fine for a dry run, never for live.');
  }
  const url = process.env.STUDIO_PUBLIC_URL || '';
  if (host !== '127.0.0.1' && !url.startsWith('https://')) {
    warnings.push('Listening publicly without an https STUDIO_PUBLIC_URL — session cookies will not be marked Secure.');
  }
  if (process.env.STUDIO_DRY_RUN === '0' && !url) {
    warnings.push('Live publishing is on but STUDIO_PUBLIC_URL is unset — OAuth callbacks and review links will not resolve.');
  }
  return warnings;
}

let server;

async function start() {
  const fatal = refuseToStart();
  if (fatal) {
    console.error(`Refusing to start: ${fatal}`);
    process.exit(1);
  }
  await store.load();
  await store.pruneSessions();
  scheduler.start();

  server = app.listen(port, host, () => {
    console.log(`RET Studio on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
    console.log(`Data: ${store.DATA_ROOT}`);
    console.log(`Platforms: ${platforms.enabled.join(', ')}`);
    if (process.env.STUDIO_DRY_RUN !== '0') {
      console.log('DRY RUN — posts are simulated, nothing is sent to any platform.');
    }
    for (const warning of startupWarnings()) console.warn(`WARNING  ${warning}`);
  });

  // Long uploads need a generous header/body window; the default 60s cuts a
  // 200MB transfer off partway on a slow connection.
  server.requestTimeout = 0;
  server.headersTimeout = 5 * 60 * 1000;
  return server;
}

// Finish in-flight requests before exiting, so a restart mid-publish does not
// leave a post half-sent.
function shutdown(signal) {
  console.log(`\n${signal} — finishing in-flight requests…`);
  scheduler.stop();
  if (!server) process.exit(0);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 15000).unref();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(signal));
}

if (require.main === module) {
  start().catch((err) => {
    console.error('Failed to start:', err);
    process.exit(1);
  });
}

module.exports = { app, start, shutdown };
