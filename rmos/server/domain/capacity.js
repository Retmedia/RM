'use strict';
const { weekStart, weekDays, isoWeek, hours, pct, today } = require('../util');
const db = require('../db');
const pipeline = require('./pipeline');
const scheduler = require('./scheduler');

/*
 * The capacity model exists to answer one question before the week starts rather
 * than after it: does the work we have promised fit in the seats we actually have?
 *
 * Three things get counted, and leaving any of them out is how a plan looks fine
 * on a chart and falls over on a Wednesday:
 *   1. Production minutes on dated jobs.
 *   2. Rework — the share that comes back for a second pass. New accounts carry more.
 *   3. Review load — the gate. It scales with everybody else's output, which is
 *      exactly why the bottleneck is invisible on a normal task board.
 */

/* Load is tracked per account in two buckets, because only one of them can be handed away. */
function bump(row, accountId, bucket, minutes) {
  const cur = row.byAccount[accountId] || { production: 0, review: 0 };
  cur[bucket] += minutes;
  row.byAccount[accountId] = cur;
}

function reworkFor(state, accountId) {
  const a = db.account(state, accountId);
  return a && typeof a.rework === 'number' ? a.rework : 0.1;
}

function forWeek(state, day) {
  const start = weekStart(day || today());
  const end = weekDays(start)[6];
  const jobs = scheduler.jobsInWeek(state, start);

  const seats = state.seats.map((s) => ({
    seatId: s.id,
    name: db.seatName(state, s.id),
    role: s.role,
    open: !!s.openSeat,
    capacityMinutes: s.capacityMinutes || 0,
    productionMinutes: 0,
    reworkMinutes: 0,
    reviewMinutes: 0,
    standingMinutes: 0,
    jobCount: 0,
    byAccount: {},
  }));
  const bySeat = new Map(seats.map((r) => [r.seatId, r]));

  /* 1. dated production, and the rework that comes with it */
  for (const j of jobs) {
    if (j.state === 'killed') continue;
    const row = bySeat.get(j.assigneeId);
    if (!row) continue;
    const rw = reworkFor(state, j.accountId);
    row.productionMinutes += j.minutes;
    row.reworkMinutes += j.minutes * rw;
    row.jobCount += 1;
    bump(row, j.accountId, 'production', j.minutes * (1 + rw));
  }

  /* 2. standing work lines — real load, no dated deliverable */
  for (const wl of state.workLines) {
    if (wl.active === false || wl.route !== 'standing') continue;
    const row = bySeat.get(wl.ownerId);
    if (!row) continue;
    row.standingMinutes += wl.minutes;
    bump(row, wl.accountId, 'production', wl.minutes);
  }

  /* 3. the gate — one line of review per job that has to stop at it */
  for (const j of jobs) {
    if (j.state === 'killed') continue;
    const acct = db.account(state, j.accountId);
    if (!acct || !acct.gateRequired || !acct.gatekeeperId) continue;
    const wl = db.workLine(state, j.workLineId);
    if (!wl || !pipeline.routeFor(state, wl).includes('gate')) continue;
    const row = bySeat.get(acct.gatekeeperId);
    if (!row) continue;
    row.reviewMinutes += acct.gateMinutes || 0;
    bump(row, j.accountId, 'review', acct.gateMinutes || 0);
  }

  for (const r of seats) {
    r.loadMinutes = Math.round(r.productionMinutes + r.reworkMinutes + r.reviewMinutes + r.standingMinutes);
    r.loadHours = hours(r.loadMinutes);
    r.capacityHours = hours(r.capacityMinutes);
    r.utilization = pct(r.loadMinutes, r.capacityMinutes);
    r.overBy = Math.max(0, r.loadMinutes - r.capacityMinutes);
    r.slack = Math.max(0, r.capacityMinutes - r.loadMinutes);
    r.byAccount = Object.entries(r.byAccount)
      .map(([accountId, parts]) => ({
        accountId,
        name: db.accountName(state, accountId),
        minutes: Math.round(parts.production + parts.review),
        /* production can be reassigned to another seat. review cannot: it moves
           only if the gatekeeper on the account changes, which is a different
           decision with a different cost. */
        productionMinutes: Math.round(parts.production),
        reviewMinutes: Math.round(parts.review),
      }))
      .sort((a, b) => b.minutes - a.minutes);
  }

  const totalLoad = seats.reduce((n, r) => n + r.loadMinutes, 0);
  const totalCapacity = seats.reduce((n, r) => n + r.capacityMinutes, 0);

  return {
    week: isoWeek(start),
    weekStart: start,
    weekEnd: end,
    seats: seats.sort((a, b) => b.utilization - a.utilization),
    totals: {
      loadMinutes: totalLoad,
      capacityMinutes: totalCapacity,
      utilization: pct(totalLoad, totalCapacity),
      jobCount: jobs.length,
      overloaded: seats.filter((r) => r.utilization > 100).map((r) => r.name),
    },
  };
}

/*
 * When a seat is over, this says what to drop and what dropping it buys. It works
 * down from the lowest-priority work lines, because the alternative — deciding in
 * the moment, on a Thursday — is how the flagship gets shipped late instead of the
 * story that nobody was waiting for.
 */
function reliefFor(state, seatId, day) {
  const cap = forWeek(state, day);
  const row = cap.seats.find((r) => r.seatId === seatId);
  if (!row || row.overBy <= 0) return { seatId, needed: 0, options: [] };

  const start = cap.weekStart;
  const end = cap.weekEnd;
  const jobs = state.jobs.filter(
    (j) => j.assigneeId === seatId && j.dueOn >= start && j.dueOn <= end && !pipeline.isTerminal(j.state),
  );

  const groups = new Map();
  for (const j of jobs) {
    const g = groups.get(j.workLineId) || { workLineId: j.workLineId, jobs: 0, minutes: 0 };
    g.jobs += 1;
    g.minutes += j.minutes * (1 + reworkFor(state, j.accountId));
    groups.set(j.workLineId, g);
  }
  for (const wl of state.workLines) {
    if (wl.route !== 'standing' || wl.ownerId !== seatId || wl.active === false) continue;
    groups.set(wl.id, { workLineId: wl.id, jobs: 0, minutes: wl.minutes, standing: true });
  }

  const options = [...groups.values()]
    .map((g) => {
      const wl = db.workLine(state, g.workLineId);
      return {
        workLineId: g.workLineId,
        title: wl ? wl.title : g.workLineId,
        account: wl ? db.accountName(state, wl.accountId) : '',
        accountId: wl ? wl.accountId : null,
        priority: wl ? wl.priority || 2 : 2,
        standing: !!g.standing,
        jobs: g.jobs,
        minutes: Math.round(g.minutes),
        hours: hours(g.minutes),
      };
    })
    .sort((a, b) => (b.priority - a.priority) || (b.minutes - a.minutes));

  /* Walk the lowest-priority work down until the seat fits. */
  let remaining = row.overBy;
  const recommend = [];
  for (const o of options) {
    if (remaining <= 0) break;
    recommend.push(o);
    remaining -= o.minutes;
  }

  /*
   * Shaving small jobs is a way of not making a decision. The structural answer is
   * usually to move a whole account off the seat, so it gets costed and ranked too,
   * and anything that solves the overload on its own is marked as such.
   */
  const accountMoves = row.byAccount
    .map((a) => ({
      accountId: a.accountId,
      name: a.name,
      minutes: a.minutes,
      hours: hours(a.minutes),
      movableMinutes: a.productionMinutes,
      movableHours: hours(a.productionMinutes),
      reviewMinutes: a.reviewMinutes,
      reviewHours: hours(a.reviewMinutes),
      gateBound: a.reviewMinutes > a.productionMinutes,
      solvesIt: a.productionMinutes >= row.overBy,
      leavesAt: pct(row.loadMinutes - a.productionMinutes, row.capacityMinutes),
      note: a.reviewMinutes > 0
        ? `${hours(a.reviewMinutes)}h of this is the gate and stays with them unless the gatekeeper changes.`
        : null,
    }))
    .sort((a, b) => Number(b.solvesIt) - Number(a.solvesIt) || a.movableMinutes - b.movableMinutes);

  return {
    seatId,
    name: row.name,
    overBy: row.overBy,
    accountMoves,
    overHours: hours(row.overBy),
    utilization: row.utilization,
    needed: row.overBy,
    recommend,
    options,
    /* moving beats cutting when somebody else has the room */
    absorbers: cap.seats
      .filter((r) => r.seatId !== seatId && r.slack > 60 && !r.open)
      .map((r) => ({ seatId: r.seatId, name: r.name, slackHours: hours(r.slack) })),
  };
}

module.exports = { forWeek, reliefFor, reworkFor };
