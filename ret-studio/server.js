import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';

import { load, update } from './src/store.js';
import { PLATFORMS, PLATFORM_IDS, liveState } from './src/platforms.js';
import { seed, newToken } from './src/seed.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3941);
const ORIGIN = process.env.STUDIO_ORIGIN || `http://127.0.0.1:${PORT}`;
const PASSWORD = process.env.CADENT_PASSWORD || 'changeme';
const BRAND = process.env.CADENT_BRAND || 'Cadent';

const CADENCES = new Set(['daily', 'weekdays', 'three', 'two', 'off']);
const sessions = new Set();

seed();

/* ---------- helpers ---------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(payload);
}

async function readBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('body must be JSON');
  }
}

function cookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function signedIn(req) {
  const sid = cookies(req).cadent_sid;
  return Boolean(sid && sessions.has(sid));
}

function samePassword(given) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(PASSWORD);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function creatorById(id) {
  return load().creators.find((c) => c.id === id) || null;
}

function creatorByToken(token) {
  const grant = load().grants[token];
  if (!grant) return null;
  return creatorById(grant.creatorId);
}

// What the grant page renders. Deliberately small: no tokens, no operator data.
function grantView(creator) {
  const live = liveState();
  return {
    brand: BRAND,
    creator: {
      id: creator.id,
      name: creator.name,
      firstName: creator.name.split(' ')[0],
      timezone: creator.timezone
    },
    platforms: PLATFORMS.map((p) => ({
      id: p.id,
      name: p.name,
      sub: p.sub,
      color: p.color,
      ownerOnly: Boolean(p.ownerOnly),
      live: live[p.id].live,
      review: live[p.id].review,
      account: creator.accounts[p.id]
    })),
    plan: creator.plan
  };
}

function deskView() {
  const live = liveState();
  const data = load();
  return {
    brand: BRAND,
    origin: ORIGIN,
    live,
    anyLive: PLATFORM_IDS.some((id) => live[id].live),
    platforms: PLATFORMS.map((p) => ({ id: p.id, name: p.name, color: p.color })),
    creators: data.creators.map((c) => ({
      id: c.id,
      name: c.name,
      handle: c.handle,
      timezone: c.timezone,
      approvalRequired: c.approvalRequired,
      accounts: c.accounts,
      plan: c.plan,
      connected: PLATFORM_IDS.filter((id) => c.accounts[id].state === 'connected').length,
      link: Object.entries(data.grants).find(([, g]) => g.creatorId === c.id)?.[0] || null
    }))
  };
}

/* ---------- api ---------- */

async function api(req, res, url) {
  const path = url.pathname;

  if (path === '/api/session' && req.method === 'GET') {
    return json(res, 200, { brand: BRAND, signedIn: signedIn(req) });
  }

  if (path === '/api/login' && req.method === 'POST') {
    const body = await readBody(req);
    if (!samePassword(body.password)) {
      return json(res, 401, { error: 'That password did not match.' });
    }
    const sid = randomBytes(18).toString('base64url');
    sessions.add(sid);
    res.setHeader('set-cookie', `cadent_sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`);
    return json(res, 200, { ok: true });
  }

  if (path === '/api/logout' && req.method === 'POST') {
    const sid = cookies(req).cadent_sid;
    if (sid) sessions.delete(sid);
    res.setHeader('set-cookie', 'cadent_sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    return json(res, 200, { ok: true });
  }

  /* --- grant: no operator session, the token is the key --- */

  if (path === '/api/grant' && req.method === 'GET') {
    const creator = creatorByToken(url.searchParams.get('t') || '');
    if (!creator) return json(res, 404, { error: 'This link is not valid any more.' });
    return json(res, 200, grantView(creator));
  }

  if (path === '/api/grant/connect' && req.method === 'POST') {
    const body = await readBody(req);
    const creator = creatorByToken(body.t);
    if (!creator) return json(res, 404, { error: 'This link is not valid any more.' });
    if (!PLATFORM_IDS.includes(body.platform)) return json(res, 400, { error: 'Unknown platform.' });

    const live = liveState()[body.platform];
    if (live.live) {
      // Real OAuth hands the token back on /api/oauth/callback and flips the account to
      // connected. Until the platform apps exist there is nothing to redirect to.
      return json(res, 200, {
        mode: 'live',
        authUrl: `/api/oauth/start?platform=${body.platform}&t=${encodeURIComponent(body.t)}`
      });
    }

    const handle = String(body.handle || creator.handle || '').replace(/^@/, '').trim();
    update((d) => {
      const c = d.creators.find((x) => x.id === creator.id);
      c.accounts[body.platform] = {
        state: 'connected',
        handle,
        connectedAt: new Date().toISOString(),
        mode: 'test'
      };
      return d;
    });
    return json(res, 200, { mode: 'test', account: creatorById(creator.id).accounts[body.platform] });
  }

  if (path === '/api/grant/disconnect' && req.method === 'POST') {
    const body = await readBody(req);
    const creator = creatorByToken(body.t);
    if (!creator) return json(res, 404, { error: 'This link is not valid any more.' });
    if (!PLATFORM_IDS.includes(body.platform)) return json(res, 400, { error: 'Unknown platform.' });
    update((d) => {
      const c = d.creators.find((x) => x.id === creator.id);
      c.accounts[body.platform] = { state: 'idle', handle: '', connectedAt: null, mode: null };
      c.plan.routes = c.plan.routes.filter((r) => r.from !== body.platform && r.to !== body.platform);
      return d;
    });
    return json(res, 200, { ok: true, plan: creatorById(creator.id).plan });
  }

  if (path === '/api/grant/plan' && req.method === 'POST') {
    const body = await readBody(req);
    const creator = creatorByToken(body.t);
    if (!creator) return json(res, 404, { error: 'This link is not valid any more.' });

    const cadence = CADENCES.has(body.cadence) ? body.cadence : 'off';
    const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(body.time || '') ? body.time : '09:00';
    const seen = new Set();
    const routes = (Array.isArray(body.routes) ? body.routes : [])
      .filter((r) => PLATFORM_IDS.includes(r?.from) && PLATFORM_IDS.includes(r?.to) && r.from !== r.to)
      .filter((r) => {
        const key = `${r.from}>${r.to}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((r) => ({ from: r.from, to: r.to }));

    update((d) => {
      const c = d.creators.find((x) => x.id === creator.id);
      c.plan = { cadence, time, routes, captionFrom: 'title' };
      return d;
    });
    return json(res, 200, { ok: true, plan: creatorById(creator.id).plan });
  }

  if (path === '/api/oauth/start' && req.method === 'GET') {
    return json(res, 501, {
      error: 'Live OAuth is not wired up in this build. Set the platform app keys and drop in the OAuth handler.'
    });
  }

  /* --- desk: operator only --- */

  if (path.startsWith('/api/desk')) {
    if (!signedIn(req)) return json(res, 401, { error: 'Sign in first.' });

    if (path === '/api/desk' && req.method === 'GET') {
      return json(res, 200, deskView());
    }

    if (path === '/api/desk/link' && req.method === 'POST') {
      const body = await readBody(req);
      const creator = creatorById(body.creatorId);
      if (!creator) return json(res, 404, { error: 'No such creator.' });
      const token = newToken();
      update((d) => {
        for (const [t, g] of Object.entries(d.grants)) {
          if (g.creatorId === creator.id) delete d.grants[t];
        }
        d.grants[token] = { creatorId: creator.id, createdAt: new Date().toISOString() };
        return d;
      });
      return json(res, 200, { token, url: `${ORIGIN}/g?t=${token}` });
    }

    if (path === '/api/desk/creator' && req.method === 'POST') {
      const body = await readBody(req);
      const creator = creatorById(body.creatorId);
      if (!creator) return json(res, 404, { error: 'No such creator.' });
      update((d) => {
        const c = d.creators.find((x) => x.id === creator.id);
        if (typeof body.approvalRequired === 'boolean') c.approvalRequired = body.approvalRequired;
        return d;
      });
      return json(res, 200, { ok: true });
    }
  }

  return json(res, 404, { error: 'No such endpoint.' });
}

/* ---------- static ---------- */

async function serveFile(res, file, code = 200) {
  const body = await readFile(file);
  res.writeHead(code, {
    'content-type': MIME[extname(file)] || 'application/octet-stream',
    'cache-control': 'no-cache'
  });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname === '/g') return await serveFile(res, join(PUBLIC, 'grant.html'));
    if (url.pathname === '/') return await serveFile(res, join(PUBLIC, 'desk.html'));

    const rel = normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
    const file = join(PUBLIC, rel);
    if (file.startsWith(PUBLIC) && existsSync(file)) return await serveFile(res, file);

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  } catch (err) {
    const code = /body/.test(err.message) ? 400 : 500;
    if (!res.headersSent) json(res, code, { error: err.message });
    else res.end();
  }
});

server.listen(PORT, () => {
  const live = liveState();
  const pending = PLATFORMS.filter((p) => !live[p.id].live).map((p) => p.name);
  console.log(`${BRAND} desk   ${ORIGIN}`);
  if (pending.length) console.log(`Test connect: ${pending.join(', ')} (no live app keys / review)`);
  if (PASSWORD === 'changeme') console.log('Operator password is still "changeme" - set CADENT_PASSWORD.');
});
