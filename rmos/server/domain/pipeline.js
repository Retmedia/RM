'use strict';
const { uid, today } = require('../util');
const db = require('../db');

/*
 * The pipeline is a state machine, and it is deliberately not a free-form board.
 * The whole argument of the org plan is that one person owns the flagship and one
 * part-time manager is the last line of defence before a client sees the work. A
 * board you can drag anything anywhere on cannot enforce that. This can.
 */

const STATES = ['footage', 'editing', 'senior_review', 'gate', 'scheduled', 'posted'];

const STATE_LABELS = {
  footage: 'Waiting on footage',
  editing: 'Editing',
  senior_review: 'Senior review',
  gate: 'Olivia’s gate',
  scheduled: 'Scheduled',
  posted: 'Posted',
  blocked: 'Blocked',
  killed: 'Dropped',
};

/* Which states a work line actually passes through, by route. */
const ROUTES = {
  full: ['footage', 'editing', 'senior_review', 'gate', 'scheduled', 'posted'],
  lite: ['editing', 'gate', 'scheduled', 'posted'],
  direct: ['editing', 'scheduled', 'posted'],
  standing: [],
};

function routeFor(state, wl) {
  const route = ROUTES[wl.route] || ROUTES.full;
  const acct = db.account(state, wl.accountId);
  /* An account with the gate switched off never stops at it, whatever the route says. */
  if (acct && !acct.gateRequired) return route.filter((s) => s !== 'gate');
  return route;
}

function isTerminal(s) {
  return s === 'posted' || s === 'killed';
}

/* ---------- who is allowed to move a job ---------- */

/*
 * Two rules, and they are the reason this exists:
 *   1. Only the named gatekeeper can clear the gate. Not the editor, not the
 *      founder in a hurry at 11pm.
 *   2. A seat capped to certain accounts cannot pick up work outside them, which
 *      is what keeps the interns from looking like capacity they are not.
 */
function canAssign(state, seatId, accountId) {
  const s = db.seat(state, seatId);
  if (!s) return { ok: false, reason: `no such seat: ${seatId}` };
  if (s.onlyAccounts && s.onlyAccounts.length && !s.onlyAccounts.includes(accountId)) {
    return {
      ok: false,
      reason: `${s.name || s.role} is capped to ${s.onlyAccounts.map((a) => db.accountName(state, a)).join(', ')} and cannot take ${db.accountName(state, accountId)}`,
    };
  }
  return { ok: true };
}

function gateFrozen(state, accountId) {
  const f = state.org && state.org.gateFreeze;
  if (!f || f.accountId !== accountId) return null;
  if (f.until && today() > f.until) return null;
  return f;
}

/*
 * transition() is the only way a job changes state. Everything else — the CLI,
 * the API, the dashboard — goes through here, so the rules cannot be walked around
 * by using a different door.
 */
function transition(state, jobId, next, opts = {}) {
  const j = db.job(state, jobId);
  if (!j) return { ok: false, reason: `no such job: ${jobId}` };
  const wl = db.workLine(state, j.workLineId);
  if (!wl) return { ok: false, reason: `job ${jobId} points at a work line that no longer exists` };
  const acct = db.account(state, j.accountId);
  const actor = opts.actor || j.assigneeId;

  if (isTerminal(j.state) && next !== j.state) {
    return { ok: false, reason: `${jobId} is ${j.state} and does not move again` };
  }

  if (next === 'blocked') {
    j.blockers.push({ at: today(), why: opts.why || 'blocked', by: actor });
    return commit(state, j, 'blocked', actor, opts.why || 'blocked');
  }
  if (next === 'killed') {
    return commit(state, j, 'killed', actor, opts.why || 'dropped');
  }

  const path = routeFor(state, wl);
  if (!path.includes(next)) {
    return { ok: false, reason: `${next} is not a step on the ${wl.route} route (${path.join(' → ')})` };
  }

  /* Coming back from blocked, resume wherever you were told to resume. */
  const from = j.state === 'blocked' ? (j.stateBeforeBlock || path[0]) : j.state;
  const here = path.indexOf(from);
  const there = path.indexOf(next);

  if (j.state !== 'blocked' && there > here + 1) {
    const skipped = path.slice(here + 1, there);
    return {
      ok: false,
      reason: `cannot skip ${skipped.map((s) => STATE_LABELS[s]).join(' and ')}. ${jobId} is at ${STATE_LABELS[from]}`,
    };
  }

  /*
   * The gate. Only the gatekeeper acts on it — passing or rejecting — and during a
   * freeze there is no override at all, including for the founder. A rejection is
   * addressed to the gate itself rather than to a later state, so it is checked
   * here and not by whether the job is moving forward.
   */
  if (from === 'gate') {
    const rejecting = opts.verdict === 'reject';
    const advancing = there > here;
    if (rejecting || advancing) {
      const keeper = acct && acct.gatekeeperId;
      if (keeper && actor !== keeper) {
        const freeze = gateFrozen(state, j.accountId);
        const who = db.seatName(state, keeper);
        if (freeze) {
          return { ok: false, reason: `${db.accountName(state, j.accountId)} is under a gate freeze until ${freeze.until}. Only ${who} clears it, and there is no override.` };
        }
        return { ok: false, reason: `only ${who} clears the gate on ${db.accountName(state, j.accountId)}` };
      }
      if (rejecting) {
        j.gateNotes = j.gateNotes || [];
        j.gateNotes.push({ at: today(), by: actor, note: opts.why || 'sent back' });
        const back = path.includes('senior_review') ? 'senior_review' : 'editing';
        return commit(state, j, back, actor, `gate: ${opts.why || 'sent back'}`);
      }
      j.gatePassedOn = today();
      j.gatePassedBy = actor;
    }
  }

  if (next === 'posted') {
    j.postedOn = opts.on || today();
    state.postLog.push({
      jobId: j.id, accountId: j.accountId, workLineId: j.workLineId,
      on: j.postedOn, platforms: j.platforms, by: actor,
    });
  }

  return commit(state, j, next, actor, opts.why || '');
}

function commit(state, j, next, actor, why) {
  const from = j.state;
  if (next === 'blocked') j.stateBeforeBlock = from;
  j.state = next;
  j.touchedOn = today();
  j.history.push({ at: today(), from, to: next, by: actor || null, why: why || '' });
  return { ok: true, job: j, from, to: next };
}

function create(state, { workLineId, dueOn, id, assigneeId }) {
  const wl = db.workLine(state, workLineId);
  if (!wl) throw new Error(`no such work line: ${workLineId}`);
  const path = routeFor(state, wl);
  const owner = assigneeId || wl.ownerId;
  const check = canAssign(state, owner, wl.accountId);
  if (!check.ok) throw new Error(check.reason);
  const j = {
    id: id || uid('j'),
    workLineId,
    accountId: wl.accountId,
    title: wl.title,
    assigneeId: owner,
    state: path[0] || 'editing',
    dueOn,
    minutes: wl.minutes,
    platforms: wl.platforms || [],
    priority: wl.priority || 2,
    standardId: wl.standardId || null,
    createdOn: today(),
    touchedOn: today(),
    history: [],
    blockers: [],
  };
  state.jobs.push(j);
  return j;
}

/* Where a job sits relative to where it should be by now. */
function isLate(j, asOf) {
  return !isTerminal(j.state) && j.dueOn < (asOf || today());
}

function openJobs(state) {
  return state.jobs.filter((j) => !isTerminal(j.state));
}

module.exports = {
  STATES, STATE_LABELS, ROUTES,
  routeFor, isTerminal, canAssign, gateFrozen,
  transition, create, isLate, openJobs,
};
