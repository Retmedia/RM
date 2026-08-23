'use strict';
const { today, weekStart, weekDays, dayName, hours, money, daysBetween } = require('../util');
const db = require('../db');
const pipeline = require('./pipeline');
const capacity = require('./capacity');
const alerts = require('./alerts');
const scheduler = require('./scheduler');

/*
 * Two readers, two different questions.
 *
 * A person opening their brief wants to know what is theirs today and what is
 * waiting on them. Garrett opening the pulse wants to know which of his accounts
 * is about to embarrass him. Neither wants a list of everything.
 */

function forSeat(state, seatId, day) {
  const now = day || today();
  const seat = db.seat(state, seatId);
  if (!seat) return null;
  const cap = capacity.forWeek(state, now);
  const row = cap.seats.find((r) => r.seatId === seatId);

  const mine = state.jobs.filter((j) => j.assigneeId === seatId && !pipeline.isTerminal(j.state));
  const decorate = (j) => ({
    id: j.id,
    title: j.title,
    account: db.accountName(state, j.accountId),
    accountId: j.accountId,
    state: j.state,
    stateLabel: pipeline.STATE_LABELS[j.state],
    dueOn: j.dueOn,
    minutes: j.minutes,
    priority: j.priority,
    standardId: j.standardId,
  });

  const dueToday = mine.filter((j) => j.dueOn === now).map(decorate);
  const late = mine.filter((j) => j.dueOn < now).map(decorate);
  const ahead = mine.filter((j) => j.dueOn > now && j.dueOn <= weekDays(weekStart(now))[6]).map(decorate);
  const blocked = state.jobs.filter((j) => j.assigneeId === seatId && j.state === 'blocked').map(decorate);

  /* Anything sitting on this person that is stopping somebody else. */
  const gateAccounts = state.accounts.filter((a) => a.gatekeeperId === seatId);
  const atMyGate = state.jobs
    .filter((j) => j.state === 'gate' && gateAccounts.some((a) => a.id === j.accountId))
    .map(decorate)
    .sort((a, b) => a.dueOn.localeCompare(b.dueOn));

  const reports = state.seats.filter((s) => s.reportsTo === seatId);
  const atMyReview = state.jobs
    .filter((j) => j.state === 'senior_review' && reports.some((r) => r.id === j.assigneeId))
    .map(decorate);

  /* Standing commitments do not appear as jobs, and they are the ones that get dropped. */
  const standing = state.workLines
    .filter((wl) => wl.ownerId === seatId && wl.route === 'standing' && wl.active !== false)
    .map((wl) => ({ id: wl.id, title: wl.title, account: db.accountName(state, wl.accountId), minutes: wl.minutes, standardId: wl.standardId }));

  const dailyFloors = state.workLines
    .filter((wl) => wl.ownerId === seatId && wl.cadence === 'daily' && wl.standardId && wl.route === 'direct')
    .map((wl) => ({ id: wl.id, title: wl.title, standardId: wl.standardId }));

  const mineAlerts = alerts.run(state, now).filter((a) => a.seatId === seatId);

  return {
    on: now,
    dayName: dayName(now),
    seat: { id: seat.id, name: db.seatName(state, seat.id), role: seat.role },
    load: row
      ? { utilization: row.utilization, loadHours: row.loadHours, capacityHours: row.capacityHours, week: cap.week }
      : null,
    dueToday, late, ahead, blocked, atMyGate, atMyReview, standing, dailyFloors,
    alerts: mineAlerts,
  };
}

function pulse(state, day) {
  const now = day || today();
  const cap = capacity.forWeek(state, now);
  const list = alerts.run(state, now);
  const sum = alerts.summary(list);

  const start = weekStart(now);
  const end = weekDays(start)[6];
  const week = state.jobs.filter((j) => j.dueOn >= start && j.dueOn <= end);
  const postedThisWeek = state.postLog.filter((p) => p.on >= start && p.on <= end).length;

  const accounts = state.accounts
    .filter((a) => a.status !== 'archived')
    .map((a) => {
      const lines = state.workLines.filter((wl) => wl.accountId === a.id && wl.active !== false && wl.route !== 'standing');
      const promised = Math.round(lines.reduce((n, wl) => n + scheduler.weeklyPromise(wl), 0));
      const jobs = week.filter((j) => j.accountId === a.id);
      const done = jobs.filter((j) => j.state === 'posted').length;
      const blockers = list.filter((x) => x.accountId === a.id);
      return {
        id: a.id,
        name: a.name,
        client: a.client,
        tier: a.tier,
        status: a.status,
        owner: db.seatName(state, a.ownerId),
        promisedPerWeek: promised,
        scheduled: jobs.length,
        posted: done,
        gate: a.gateRequired ? db.seatName(state, a.gatekeeperId) : null,
        highAlerts: blockers.filter((x) => x.severity === 'high').length,
        alerts: blockers.length,
        retainer: a.retainer || 0,
      };
    })
    .sort((a, b) => b.highAlerts - a.highAlerts || b.promisedPerWeek - a.promisedPerWeek);

  const mrr = state.accounts.reduce((n, a) => n + (a.retainer || 0), 0);

  return {
    on: now,
    week: cap.week,
    org: state.org,
    capacity: cap,
    alerts: { summary: sum, top: list.filter((a) => a.severity === 'high').slice(0, 6), all: list },
    board: {
      scheduled: week.length,
      posted: postedThisWeek,
      inGate: state.jobs.filter((j) => j.state === 'gate').length,
      blocked: state.jobs.filter((j) => j.state === 'blocked').length,
      late: pipeline.openJobs(state).filter((j) => pipeline.isLate(j, now)).length,
    },
    accounts,
    money: { recurring: mrr, accountsPaying: state.accounts.filter((a) => a.retainer).length },
  };
}

/* ---------- plain text renderers, for the terminal and the daily email ---------- */

const rule = (s) => `${s}\n${'─'.repeat(Math.min(s.length, 68))}`;

function renderSeatBrief(b) {
  if (!b) return 'No such seat.';
  const L = [];
  L.push(rule(`${b.seat.name} — ${b.dayName} ${b.on}`));
  if (b.load) {
    const flag = b.load.utilization > 100 ? '  ⚠ over capacity' : b.load.utilization >= 90 ? '  ⚠ no slack' : '';
    L.push(`Week ${b.load.week}: ${b.load.loadHours}h of work against ${b.load.capacityHours}h — ${b.load.utilization}%${flag}`);
  }
  L.push('');

  if (b.atMyGate.length) {
    L.push(`WAITING ON YOU — ${b.atMyGate.length} at your gate`);
    for (const j of b.atMyGate) L.push(`  · ${j.account} — ${j.title} (due ${j.dueOn})`);
    L.push('  Nothing behind these moves until you clear them.');
    L.push('');
  }
  if (b.atMyReview.length) {
    L.push(`YOUR REVIEW — ${b.atMyReview.length} from your reports`);
    for (const j of b.atMyReview) L.push(`  · ${j.account} — ${j.title}`);
    L.push('');
  }
  if (b.late.length) {
    L.push(`LATE — ${b.late.length}`);
    for (const j of b.late.slice(0, 10)) L.push(`  · ${j.dueOn}  ${j.account} — ${j.title} [${j.stateLabel}]`);
    if (b.late.length > 10) L.push(`  … and ${b.late.length - 10} more`);
    L.push('');
  }
  L.push(`TODAY — ${b.dueToday.length}`);
  if (!b.dueToday.length) L.push('  Nothing dated today.');
  for (const j of b.dueToday) L.push(`  · ${j.account} — ${j.title} [${j.stateLabel}] ${j.minutes}m`);
  L.push('');
  if (b.dailyFloors.length) {
    L.push('DAILY FLOOR — done or not done, no middle');
    for (const f of b.dailyFloors) L.push(`  · ${f.title}`);
    L.push('');
  }
  if (b.standing.length) {
    L.push('STANDING — no due date, still real work');
    for (const s of b.standing) L.push(`  · ${s.account} — ${s.title} (${hours(s.minutes)}h/wk)`);
    L.push('');
  }
  if (b.blocked.length) {
    L.push(`BLOCKED — ${b.blocked.length}`);
    for (const j of b.blocked) L.push(`  · ${j.account} — ${j.title}`);
    L.push('');
  }
  if (b.alerts.length) {
    L.push('FLAGGED');
    for (const a of b.alerts) L.push(`  [${a.severity}] ${a.title}\n        → ${a.action}`);
    L.push('');
  }
  return L.join('\n');
}

function renderPulse(p) {
  const L = [];
  L.push(rule(`RET Media — ${p.on} (${p.week})`));
  L.push(`Board: ${p.board.scheduled} scheduled · ${p.board.posted} posted · ${p.board.inGate} at the gate · ${p.board.late} late · ${p.board.blocked} blocked`);
  L.push(`Capacity: ${p.capacity.totals.utilization}% across the agency${p.capacity.totals.overloaded.length ? ` — over: ${p.capacity.totals.overloaded.join(', ')}` : ''}`);
  L.push(`Recurring: ${money(p.money.recurring)}/mo across ${p.money.accountsPaying} accounts`);
  L.push('');

  L.push(`NEEDS YOU TODAY — ${p.alerts.summary.high} high, ${p.alerts.summary.med} medium, ${p.alerts.summary.low} low`);
  for (const a of p.alerts.top) {
    L.push(`  ▸ ${a.title}`);
    L.push(`    ${a.detail}`);
    L.push(`    → ${a.action}`);
  }
  L.push('');

  L.push('SEATS');
  for (const s of p.capacity.seats) {
    if (!s.capacityMinutes) continue;
    const bar = '█'.repeat(Math.min(20, Math.round(s.utilization / 5))).padEnd(20, '·');
    L.push(`  ${bar} ${String(s.utilization).padStart(4)}%  ${s.name} (${s.loadHours}/${s.capacityHours}h)`);
  }
  L.push('');

  L.push('ACCOUNTS');
  for (const a of p.accounts) {
    const flag = a.highAlerts ? ` ⚠ ${a.highAlerts}` : '';
    L.push(`  ${a.name.padEnd(18)} ${String(a.promisedPerWeek).padStart(3)}/wk promised · ${String(a.scheduled).padStart(3)} scheduled · owner ${a.owner}${flag}`);
  }
  return L.join('\n');
}

module.exports = { forSeat, pulse, renderSeatBrief, renderPulse };
