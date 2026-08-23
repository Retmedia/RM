'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const db = require('./db');
const util = require('./util');
const pipeline = require('./domain/pipeline');
const scheduler = require('./domain/scheduler');
const capacity = require('./domain/capacity');
const alerts = require('./domain/alerts');
const brief = require('./domain/brief');

/*
 * Bound to localhost, no dependencies, no build step. The whole agency is one
 * laptop and a handful of contractors; anything that needs a deploy pipeline to
 * show Garrett his own week is the wrong shape of tool.
 */

const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function send(res, code, body, type = 'application/json; charset=utf-8') {
  const payload = type.startsWith('application/json') ? JSON.stringify(body) : body;
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('body is not JSON')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);
  /* Never serve anything outside public/, whatever the path claims to be. */
  if (!file.startsWith(PUBLIC)) return send(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: 'not found' });
    send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream');
  });
}

const routes = [];
const on = (method, pattern, handler) => routes.push({ method, pattern, handler });

/* ---------- reads ---------- */

on('GET', /^\/api\/health$/, (_m, _q, _b, state) => ({
  ok: true, store: db.DB_PATH, seats: state.seats.length, accounts: state.accounts.length, jobs: state.jobs.length,
}));

on('GET', /^\/api\/state$/, (_m, q, _b, state) => {
  const day = q.get('on') || util.today();
  return {
    on: day,
    org: state.org,
    seats: state.seats.map((s) => ({ ...s, displayName: db.seatName(state, s.id) })),
    accounts: state.accounts,
    workLines: state.workLines,
    access: state.access,
    standards: state.standards,
    decisions: state.decisions,
    jobs: state.jobs,
    capacity: capacity.forWeek(state, day),
    alerts: alerts.run(state, day),
    pulse: brief.pulse(state, day),
    states: pipeline.STATES,
    stateLabels: pipeline.STATE_LABELS,
  };
});

on('GET', /^\/api\/pulse$/, (_m, q, _b, state) => brief.pulse(state, q.get('on') || util.today()));

on('GET', /^\/api\/brief\/([\w-]+)$/, (m, q, _b, state) => {
  const b = brief.forSeat(state, m[1], q.get('on') || util.today());
  if (!b) throw httpError(404, `no such seat: ${m[1]}`);
  return b;
});

on('GET', /^\/api\/capacity$/, (_m, q, _b, state) => capacity.forWeek(state, q.get('on') || util.today()));

on('GET', /^\/api\/relief\/([\w-]+)$/, (m, q, _b, state) => capacity.reliefFor(state, m[1], q.get('on') || util.today()));

on('GET', /^\/api\/alerts$/, (_m, q, _b, state) => {
  let list = alerts.run(state, q.get('on') || util.today());
  const s = q.get('severity');
  if (s) list = list.filter((a) => a.severity === s);
  return { summary: alerts.summary(list), alerts: list };
});

on('GET', /^\/api\/board$/, (_m, q, _b, state) => {
  let jobs = q.get('all') ? state.jobs : pipeline.openJobs(state);
  if (q.get('account')) jobs = jobs.filter((j) => j.accountId === q.get('account'));
  if (q.get('owner')) jobs = jobs.filter((j) => j.assigneeId === q.get('owner'));
  if (q.get('state')) jobs = jobs.filter((j) => j.state === q.get('state'));
  return { jobs };
});

on('GET', /^\/api\/standards\/([\w-]+)$/, (m, _q, _b, state) => {
  const std = db.standard(state, m[1]);
  if (!std) throw httpError(404, `no such standard: ${m[1]}`);
  return std;
});

/* ---------- writes ---------- */

on('POST', /^\/api\/week$/, (_m, _q, body, state) => {
  const r = scheduler.generateWeek(state, body.on || util.today(), { backfill: !!body.backfill });
  db.save(state);
  return { week: r.week, weekStart: r.weekStart, created: r.created.length, skipped: r.skipped, daysSkipped: r.daysSkipped };
});

on('POST', /^\/api\/jobs\/([\w-]+)\/move$/, (m, _q, body, state) => {
  const r = pipeline.transition(state, m[1], body.to, {
    actor: body.actor, why: body.why, verdict: body.verdict, on: body.on,
  });
  if (!r.ok) throw httpError(409, r.reason);
  db.save(state);
  return { ok: true, job: r.job, from: r.from, to: r.to };
});

on('POST', /^\/api\/access\/([\w-]+)$/, (m, _q, body, state) => {
  const g = state.access.find((x) => x.id === m[1]);
  if (!g) throw httpError(404, `no such access grant: ${m[1]}`);
  for (const k of ['status', 'holder', 'account', 'expiresOn', 'level', 'note']) {
    if (body[k] !== undefined) g[k] = body[k];
  }
  if (body.status === 'granted' && !g.grantedOn) g.grantedOn = util.today();
  db.save(state);
  return { ok: true, grant: g };
});

on('POST', /^\/api\/decisions\/([\w-]+)$/, (m, _q, body, state) => {
  const d = state.decisions.find((x) => x.id === m[1]);
  if (!d) throw httpError(404, `no such decision: ${m[1]}`);
  if (!['open', 'done', 'watch'].includes(body.status)) throw httpError(400, 'status must be open, done or watch');
  d.status = body.status;
  d.decidedOn = util.today();
  db.save(state);
  return { ok: true, decision: d };
});

on('POST', /^\/api\/seats\/([\w-]+)$/, (m, _q, body, state) => {
  const s = db.seat(state, m[1]);
  if (!s) throw httpError(404, `no such seat: ${m[1]}`);
  for (const k of ['name', 'capacityMinutes', 'deputyId', 'backupRehearsedOn', 'status', 'note']) {
    if (body[k] !== undefined) s[k] = body[k];
  }
  if (body.name) { s.needsName = false; s.openSeat = false; }
  db.save(state);
  return { ok: true, seat: s };
});

on('POST', /^\/api\/workLines\/([\w-]+)$/, (m, _q, body, state) => {
  const wl = db.workLine(state, m[1]);
  if (!wl) throw httpError(404, `no such work line: ${m[1]}`);
  if (body.ownerId) {
    const check = pipeline.canAssign(state, body.ownerId, wl.accountId);
    if (!check.ok) throw httpError(409, check.reason);
  }
  for (const k of ['ownerId', 'perPeriod', 'cadence', 'anchorDay', 'minutes', 'priority', 'active', 'standardId']) {
    if (body[k] !== undefined) wl[k] = body[k];
  }
  db.save(state);
  return { ok: true, workLine: wl };
});

function httpError(code, message) {
  const e = new Error(message);
  e.status = code;
  return e;
}

/* ---------- wiring ---------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;

  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

  const route = routes.find((r) => r.method === req.method && r.pattern.test(pathname));
  if (!route) return send(res, 404, { error: `no route for ${req.method} ${pathname}` });

  try {
    const body = req.method === 'POST' ? await readBody(req) : {};
    const state = db.load();
    const result = route.handler(route.pattern.exec(pathname), url.searchParams, body, state);
    send(res, 200, result);
  } catch (e) {
    send(res, e.status || 500, { error: e.message });
  }
});

const port = Number(process.env.PORT) || 3940;
if (require.main === module || process.env.RMOS_SERVE) {
  server.listen(port, '127.0.0.1', () => {
    console.log(`RM OS on http://localhost:${port}`);
    console.log(`Store: ${db.DB_PATH}`);
  });
}

module.exports = { server };
