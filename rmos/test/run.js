'use strict';
/*
 * Zero-dependency test runner. Every test here is a rule the business depends on,
 * not a smoke test of the language: if one of these goes red, something that was
 * supposed to be impossible has become possible.
 *
 *   node test/run.js            all of it
 *   node test/run.js gate       only tests whose name contains "gate"
 */

process.env.RMOS_DB = process.env.RMOS_DB || '/dev/null/never-written';

const assert = require('node:assert/strict');
const db = require('../server/db');
const util = require('../server/util');
const pipeline = require('../server/domain/pipeline');
const scheduler = require('../server/domain/scheduler');
const capacity = require('../server/domain/capacity');
const alerts = require('../server/domain/alerts');
const brief = require('../server/domain/brief');

const filter = process.argv[2];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* A fresh in-memory agency, never written to disk. */
function fresh(day = '2026-08-24') {
  const s = db.reset();
  scheduler.generateWeek(s, day);
  return s;
}
const jobsOf = (s, workLineId) => s.jobs.filter((j) => j.workLineId === workLineId);

/* ---------- dates ---------- */

test('week starts on Monday and ISO weeks line up', () => {
  assert.equal(util.weekStart('2026-08-23'), '2026-08-17', 'Sunday belongs to the week that began on Monday');
  assert.equal(util.weekStart('2026-08-24'), '2026-08-24');
  assert.equal(util.isoWeek('2026-08-24'), '2026-W35');
  assert.equal(util.addDays('2026-12-31', 1), '2027-01-01', 'year boundary');
  assert.equal(util.addDays('2028-02-28', 1), '2028-02-29', 'leap day');
  assert.equal(util.daysBetween('2026-08-24', '2026-09-01'), 8);
});

/* ---------- the seed itself ---------- */

test('the seed is internally consistent', () => {
  const s = db.reset();
  const seatIds = new Set(s.seats.map((x) => x.id));
  const acctIds = new Set(s.accounts.map((x) => x.id));
  const stdIds = new Set(s.standards.map((x) => x.id));
  for (const wl of s.workLines) {
    assert.ok(acctIds.has(wl.accountId), `${wl.id} account`);
    assert.ok(seatIds.has(wl.ownerId), `${wl.id} owner`);
    assert.ok(pipeline.ROUTES[wl.route], `${wl.id} route`);
    if (wl.standardId) assert.ok(stdIds.has(wl.standardId), `${wl.id} standard`);
    const check = pipeline.canAssign(s, wl.ownerId, wl.accountId);
    assert.ok(check.ok, `${wl.id}: ${check.reason}`);
  }
  for (const a of s.accounts) {
    assert.ok(seatIds.has(a.ownerId), `${a.id} owner`);
    if (a.gateRequired) assert.ok(seatIds.has(a.gatekeeperId), `${a.id} gatekeeper`);
  }
});

/* ---------- the scheduler ---------- */

test('generating a week twice creates nothing the second time', () => {
  const s = db.reset();
  const first = scheduler.generateWeek(s, '2026-08-24');
  const before = s.jobs.length;
  const second = scheduler.generateWeek(s, '2026-08-24');
  assert.ok(first.created.length > 0);
  assert.equal(second.created.length, 0);
  assert.equal(s.jobs.length, before, 'no duplicates on a repeat run');
});

test('regenerating picks up a new work line without touching existing jobs', () => {
  const s = fresh();
  const target = jobsOf(s, 'wl_mew_ig')[0];
  pipeline.transition(s, target.id, 'editing', { actor: 'p_senior' });
  s.workLines.push({
    id: 'wl_test', accountId: 'c_blair', ownerId: 'p_kingdon', route: 'lite', priority: 3,
    title: 'A new promise', cadence: 'weekly', anchorDay: 'Wed', perPeriod: 1, minutes: 30, platforms: [],
  });
  const r = scheduler.generateWeek(s, '2026-08-24');
  assert.equal(r.created.length, 1);
  assert.equal(db.job(s, target.id).state, 'editing', 'work already in flight is left alone');
});

test('cadence produces the promised number of units', () => {
  const s = fresh();
  assert.equal(jobsOf(s, 'wl_mew_tt').length, 21, 'three a day, seven days');
  assert.equal(jobsOf(s, 'wl_mew_yt').length, 1, 'one a week');
  assert.equal(jobsOf(s, 'wl_paulo').length, 3, 'three on the anchor day');
  assert.equal(jobsOf(s, 'wl_mew_bench').length, 0, 'standing work never becomes a dated job');
  assert.ok(jobsOf(s, 'wl_mew_yt')[0].dueOn === '2026-08-27', 'anchored to Thursday');
});

/* ---------- the gate ---------- */

test('gate: only the named gatekeeper can clear it', () => {
  const s = fresh();
  const j = jobsOf(s, 'wl_mew_ig')[0];
  for (const st of ['editing', 'senior_review', 'gate']) {
    assert.ok(pipeline.transition(s, j.id, st, { actor: 'p_senior' }).ok, st);
  }
  const asEditor = pipeline.transition(s, j.id, 'scheduled', { actor: 'p_senior' });
  assert.equal(asEditor.ok, false, 'the editor cannot wave their own work through');
  assert.match(asEditor.reason, /gate freeze|only Olivia/);

  const asFounder = pipeline.transition(s, j.id, 'scheduled', { actor: 'p_garrett' });
  assert.equal(asFounder.ok, false, 'not even the founder, during the freeze');

  const asKeeper = pipeline.transition(s, j.id, 'scheduled', { actor: 'p_olivia' });
  assert.ok(asKeeper.ok, 'the gatekeeper can');
  assert.equal(db.job(s, j.id).gatePassedBy, 'p_olivia');
});

test('gate: the freeze expires and the ordinary rule takes over', () => {
  const s = fresh();
  s.org.gateFreeze.until = '2020-01-01';
  const j = jobsOf(s, 'wl_mew_ig')[0];
  ['editing', 'senior_review', 'gate'].forEach((st) => pipeline.transition(s, j.id, st, { actor: 'p_senior' }));
  const r = pipeline.transition(s, j.id, 'scheduled', { actor: 'p_garrett' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /only Olivia clears the gate/, 'still the gatekeeper only, just a different message');
});

test('gate: a rejection sends the work back to be recut', () => {
  const s = fresh();
  const j = jobsOf(s, 'wl_mew_ig')[0];
  ['editing', 'senior_review', 'gate'].forEach((st) => pipeline.transition(s, j.id, st, { actor: 'p_senior' }));
  const r = pipeline.transition(s, j.id, 'gate', { actor: 'p_olivia', verdict: 'reject', why: 'hook is buried' });
  assert.ok(r.ok);
  assert.equal(db.job(s, j.id).state, 'senior_review');
  assert.equal(db.job(s, j.id).gateNotes[0].note, 'hook is buried');
});

test('gate: an editor cannot reject their own work back into the queue either', () => {
  const s = fresh();
  const j = jobsOf(s, 'wl_mew_ig')[0];
  ['editing', 'senior_review', 'gate'].forEach((st) => pipeline.transition(s, j.id, st, { actor: 'p_senior' }));
  const r = pipeline.transition(s, j.id, 'gate', { actor: 'p_senior', verdict: 'reject', why: 'changed my mind' });
  assert.equal(r.ok, false, 'a rejection is a gatekeeper action, not an escape hatch');
  assert.equal(db.job(s, j.id).state, 'gate');
});

test('an account with the gate switched off never stops at it', () => {
  const s = fresh();
  const j = jobsOf(s, 'wl_paulo')[0];
  assert.equal(j.state, 'editing', 'direct route skips the footage step');
  const r = pipeline.transition(s, j.id, 'scheduled', { actor: 'p_julia' });
  assert.ok(r.ok, 'real estate goes straight through: Julia is end to end');
});

/* ---------- the state machine ---------- */

test('states cannot be skipped', () => {
  const s = fresh();
  const j = jobsOf(s, 'wl_mew_yt')[0];
  const r = pipeline.transition(s, j.id, 'posted', { actor: 'p_senior' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /cannot skip/);
});

test('posted work is terminal and is written to the delivery log', () => {
  const s = fresh();
  const j = jobsOf(s, 'wl_paulo')[0];
  ['scheduled', 'posted'].forEach((st) => pipeline.transition(s, j.id, st, { actor: 'p_julia' }));
  assert.equal(s.postLog.length, 1);
  assert.equal(s.postLog[0].accountId, 'c_paulo');
  const again = pipeline.transition(s, j.id, 'scheduled', { actor: 'p_julia' });
  assert.equal(again.ok, false, 'posted does not move again');
});

test('blocking remembers where the work was and resumes there', () => {
  const s = fresh();
  const j = jobsOf(s, 'wl_xan_short')[0];
  pipeline.transition(s, j.id, 'editing', { actor: 'p_viktor' });
  pipeline.transition(s, j.id, 'blocked', { actor: 'p_viktor', why: 'no footage from Greenland' });
  assert.equal(db.job(s, j.id).state, 'blocked');
  assert.equal(db.job(s, j.id).blockers[0].why, 'no footage from Greenland');
  const back = pipeline.transition(s, j.id, 'senior_review', { actor: 'p_viktor' });
  assert.ok(back.ok, 'resumes from where it stopped rather than starting over');
});

/* ---------- skill caps ---------- */

test('an intern capped to one account cannot be handed another', () => {
  const s = fresh();
  const check = pipeline.canAssign(s, 'p_kingdon', 'c_mew');
  assert.equal(check.ok, false);
  assert.match(check.reason, /capped to Blair Conklin/);
  assert.throws(() => pipeline.create(s, { workLineId: 'wl_mew_yt', dueOn: '2026-08-27', assigneeId: 'p_kingdon' }));
});

/* ---------- capacity ---------- */

test('capacity counts production, rework, review and standing work', () => {
  const s = fresh();
  const cap = capacity.forWeek(s, '2026-08-24');
  const olivia = cap.seats.find((r) => r.seatId === 'p_olivia');
  assert.ok(olivia.reviewMinutes > 0, 'the gate is real work and shows up on the gatekeeper');
  assert.ok(olivia.standingMinutes > 0, 'standing commitments are counted');
  assert.ok(olivia.utilization > 100, 'the part-time seat with the gate on it is over');

  const senior = cap.seats.find((r) => r.seatId === 'p_senior');
  assert.equal(senior.reviewMinutes, 0, 'the editor does not carry the gate');
  assert.ok(senior.reworkMinutes > 0, 'a 25% rework account contributes rework');
  const expected = Math.round(senior.productionMinutes + senior.reworkMinutes + senior.standingMinutes);
  assert.equal(senior.loadMinutes, expected);
});

test('capacity ignores dropped work', () => {
  const s = fresh();
  const before = capacity.forWeek(s, '2026-08-24').seats.find((r) => r.seatId === 'p_viktor').loadMinutes;
  for (const j of jobsOf(s, 'wl_xan_mid')) pipeline.transition(s, j.id, 'killed', { actor: 'p_garrett' });
  const after = capacity.forWeek(s, '2026-08-24').seats.find((r) => r.seatId === 'p_viktor').loadMinutes;
  assert.ok(after < before, 'dropping work frees the seat');
});

test('relief separates work that can move from a gate that cannot', () => {
  const s = fresh();
  const r = capacity.reliefFor(s, 'p_olivia', '2026-08-24');
  const mew = r.accountMoves.find((m) => m.accountId === 'c_mew');
  const fw = r.accountMoves.find((m) => m.accountId === 'c_fw');
  assert.ok(mew.reviewMinutes > 0, 'most of her Man Eats Wild load is the gate');
  assert.ok(mew.movableMinutes < mew.minutes, 'the gate does not move when the account does');
  assert.equal(mew.solvesIt, false, 'moving the flagship off her does not fix it');
  assert.equal(fw.solvesIt, true, 'moving Foreign Waters does');
  assert.equal(r.accountMoves[0].accountId, 'c_fw', 'and it is recommended first');
});

test('a seat inside capacity is offered no relief', () => {
  const s = fresh();
  const r = capacity.reliefFor(s, 'p_julia', '2026-08-24');
  assert.equal(r.needed, 0);
  assert.deepEqual(r.options, []);
});

/* ---------- alerts ---------- */

test('the monitors catch what they exist to catch', () => {
  const s = fresh();
  const list = alerts.run(s, '2026-08-24');
  const kinds = new Set(list.map((a) => a.kind));
  for (const k of ['access_blocker', 'access_expiring', 'access_personal', 'over_capacity',
    'open_seat_load', 'open_seat_oversubscribed', 'gate_no_deputy', 'standard_draft', 'bus_factor']) {
    assert.ok(kinds.has(k), `expected a ${k} alert`);
  }
  const cap = list.find((a) => a.kind === 'over_capacity');
  assert.match(cap.action, /Foreign Waters/, 'the fix names the account to move');
  assert.ok(list.every((a) => a.action && a.detail), 'every alert says what to do about it');
});

test('nobody is accused of missing a cadence before there is any history', () => {
  const s = fresh();
  const list = alerts.run(s, '2026-08-24');
  assert.equal(list.filter((a) => a.kind === 'cadence_gap').length, 0);
  assert.ok(list.some((a) => a.kind === 'no_baseline'), 'it says so instead');
});

test('a cadence gap appears once there is history to compare against', () => {
  const s = fresh();
  /* one post two weeks ago sets a baseline; last week then reads as a miss */
  s.postLog.push({ accountId: 'c_paulo', on: util.addDays('2026-08-24', -20), jobId: 'x', workLineId: 'wl_paulo' });
  const list = alerts.run(s, '2026-08-24');
  const gap = list.find((a) => a.kind === 'cadence_gap' && a.accountId === 'c_paulo');
  assert.ok(gap, 'the miss is reported');
  assert.equal(gap.posted, 0);
  assert.equal(gap.promised, 3);
});

test('resolving access clears its alert', () => {
  const s = fresh();
  const before = alerts.run(s, '2026-08-24').filter((a) => a.accessId === 'ac_mew_yt').length;
  assert.ok(before > 0);
  const g = s.access.find((x) => x.id === 'ac_mew_yt');
  Object.assign(g, { status: 'granted', holder: 'agency', account: 'info@retmediaagency.com' });
  const after = alerts.run(s, '2026-08-24').filter((a) => a.accessId === 'ac_mew_yt');
  assert.equal(after.length, 0, 'granting it makes the alert go away');
});

test('bus factor is weighted by workload, not by how many lines carry a name', () => {
  const s = fresh();
  const list = alerts.run(s, '2026-08-24');
  /* Man Eats Wild has a named backup, so it reports the untested-backup variant */
  assert.ok(list.some((a) => a.kind === 'bus_factor_untested' && a.accountId === 'c_mew'));
  assert.ok(!list.some((a) => a.kind === 'bus_factor' && a.accountId === 'c_mew'));

  s.seats.find((x) => x.id === 'p_viktor').backupFor = [];
  const after = alerts.run(s, '2026-08-24');
  const flagged = after.find((a) => a.kind === 'bus_factor' && a.accountId === 'c_mew');
  assert.ok(flagged, 'remove the backup and the flagship is flagged');
  assert.equal(flagged.severity, 'high');
});

/* ---------- briefs ---------- */

test('a brief shows what is waiting on that person', () => {
  const s = fresh();
  const j = jobsOf(s, 'wl_mew_ig')[0];
  ['editing', 'senior_review', 'gate'].forEach((st) => pipeline.transition(s, j.id, st, { actor: 'p_senior' }));
  const b = brief.forSeat(s, 'p_olivia', '2026-08-24');
  assert.equal(b.atMyGate.length, 1);
  assert.equal(b.atMyGate[0].id, j.id);
  assert.ok(b.load.utilization > 100);
  assert.ok(b.standing.length, 'her standing commitments are listed too');
  assert.ok(brief.renderSeatBrief(b).includes('WAITING ON YOU'));
});

test('the pulse ranks accounts by how much trouble they are in', () => {
  const s = fresh();
  const p = brief.pulse(s, '2026-08-24');
  assert.equal(p.accounts[0].id, 'c_mew', 'the flagship with three access blockers comes first');
  assert.equal(p.money.recurring, 1900);
  assert.ok(brief.renderPulse(p).includes('NEEDS YOU TODAY'));
});

/* ---------- runner ---------- */

let pass = 0;
const failures = [];
for (const t of tests) {
  if (filter && !t.name.includes(filter)) continue;
  try {
    t.fn();
    pass += 1;
    console.log(`  ok   ${t.name}`);
  } catch (e) {
    failures.push({ name: t.name, error: e });
    console.log(`  FAIL ${t.name}`);
  }
}
console.log('');
if (failures.length) {
  for (const f of failures) {
    console.log(`FAIL: ${f.name}`);
    console.log(`  ${f.error.message.split('\n').slice(0, 6).join('\n  ')}`);
    console.log('');
  }
  console.log(`${pass} passed, ${failures.length} failed`);
  process.exit(1);
}
console.log(`${pass} passed`);
