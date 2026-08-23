'use strict';
const { today, addDays, daysBetween, hours, weekStart, weekDays, dayOfMonth } = require('../util');
const db = require('../db');
const pipeline = require('./pipeline');
const scheduler = require('./scheduler');
const capacity = require('./capacity');

/*
 * The monitors. Each one is a thing that has actually gone wrong, or is one bad
 * week away from going wrong, at this agency specifically. They run on demand and
 * on a schedule, and every alert carries the action that clears it — an alert you
 * cannot act on is just anxiety with a timestamp.
 */

const SEVERITY_ORDER = { high: 0, med: 1, low: 2 };

function A(kind, severity, title, detail, action, refs = {}) {
  return { id: `${kind}:${refs.key || title}`, kind, severity, title, detail, action, ...refs };
}

/* ---------- capacity ---------- */

function overCapacity(state, day, out) {
  const cap = capacity.forWeek(state, day);
  for (const r of cap.seats) {
    if (r.capacityMinutes === 0) continue;
    if (r.utilization > 100) {
      const relief = capacity.reliefFor(state, r.seatId, day);
      const fix = (relief.accountMoves || []).find((m) => m.solvesIt);
      out.push(A('over_capacity', 'high',
        `${r.name} is at ${r.utilization}% for ${cap.week}`,
        `${r.loadHours} hours of work against ${r.capacityHours} hours of capacity, which is ${hours(r.overBy)} hours over. That gap does not disappear; it comes out of quality, out of the weekend, or out of the gate.`,
        fix
          ? `Move ${fix.name} off ${r.name} and the week fits at ${fix.leavesAt}%.`
          : `No single account move fixes it. Cut the lowest-priority work lines or raise the seat's hours.`,
        { key: r.seatId, seatId: r.seatId, week: cap.week, utilization: r.utilization }));
    } else if (r.open && r.utilization >= 85) {
      out.push(A('open_seat_oversubscribed', 'high',
        `The ${r.role} seat is already at ${r.utilization}% and nobody has been hired into it yet`,
        `${r.loadHours} hours against a ${r.capacityHours} hour week, before a single revision, a client call or a day of ramp. This is what the seat looks like on a perfect week.`,
        `Either bring the cadence down before the hire starts, or accept that this person has no room to be new at the job. Ramp is not free and it is not in these numbers.`,
        { key: r.seatId, seatId: r.seatId, week: cap.week, utilization: r.utilization }));
    } else if (r.utilization >= 90 && !r.open) {
      out.push(A('no_slack', 'med',
        `${r.name} is at ${r.utilization}% with no room to absorb anything`,
        `${hours(r.slack)} hours of slack in the week. One sick day, one client revision or one round of notes and this seat is late.`,
        `Either accept that this seat ships nothing unplanned, or move a priority-3 line off it now while it is still a choice.`,
        { key: r.seatId, seatId: r.seatId, week: cap.week }));
    }
  }
}

/* ---------- single points of failure ---------- */

function busFactor(state, out) {
  for (const acct of state.accounts) {
    if (acct.status === 'archived') continue;
    const lines = state.workLines.filter((wl) => wl.accountId === acct.id && wl.active !== false);
    if (!lines.length) continue;
    const owners = new Set(lines.map((wl) => wl.ownerId));
    /*
     * Weighted by minutes, not by how many lines somebody's name is on. Four small
     * publishing chores and one fifteen-hour edit are not two people sharing an
     * account, and counting lines would say they were.
     */
    const production = lines.filter((wl) => wl.route !== 'standing');
    if (!production.length) continue;
    const primary = {};
    for (const wl of production) {
      const load = (wl.minutes || 0) * scheduler.weeklyPromise(wl);
      primary[wl.ownerId] = (primary[wl.ownerId] || 0) + load;
    }
    const totalLoad = Object.values(primary).reduce((n, x) => n + x, 0);
    const [topId, topLoad] = Object.entries(primary).sort((a, b) => b[1] - a[1])[0] || [];
    if (!topId || !totalLoad) continue;
    const share = topLoad / totalLoad;
    const topCount = production.filter((wl) => wl.ownerId === topId).length;
    if (share < 0.6) continue;

    const backup = state.seats.find((s) => (s.backupFor || []).includes(acct.id) && s.id !== topId);
    const sev = acct.tier === 'flagship' ? 'high' : 'med';
    if (!backup) {
      out.push(A('bus_factor', sev,
        `${acct.name} runs on one person with no named backup`,
        `${db.seatName(state, topId)} carries ${Math.round(share * 100)}% of the work on this account, across ${topCount} of ${production.length} production lines. Illness, a holiday or a resignation stops it completely.`,
        `Name a backup on the seat and have them walk the workflow once before it is needed. A backup who has never seen the account is not a backup.`,
        { key: acct.id, accountId: acct.id, seatId: topId }));
    } else if (!backup.backupRehearsedOn) {
      out.push(A('bus_factor_untested', 'med',
        `${db.seatName(state, backup.id)} is the named backup on ${acct.name} and has never run it`,
        `Naming a backup is the cheap half. The mitigation only works if they have actually seen the workflow before the week they need it.`,
        `Book one handover session, then set backupRehearsedOn on the seat.`,
        { key: acct.id, accountId: acct.id, seatId: backup.id }));
    }
  }
}

function openSeatLoad(state, day, out) {
  const start = weekStart(day || today());
  const end = weekDays(start)[6];
  for (const s of state.seats) {
    if (!s.openSeat) continue;
    const jobs = state.jobs.filter((j) => j.assigneeId === s.id && j.dueOn >= start && j.dueOn <= end);
    if (!jobs.length) continue;
    const accts = [...new Set(jobs.map((j) => db.accountName(state, j.accountId)))];
    out.push(A('open_seat_load', 'high',
      `${jobs.length} deliverables this week are assigned to a seat nobody is sitting in`,
      `The ${s.role} seat is unfilled and carries ${accts.join(', ')}. Until it is filled, every one of these is really assigned to whoever is left.`,
      `Fill the seat, or reassign the week explicitly so the board stops lying about who is doing the work.`,
      { key: s.id, seatId: s.id, count: jobs.length }));
  }
  for (const s of state.seats) {
    if (!s.needsName) continue;
    out.push(A('unnamed_seat', 'low',
      `The ${s.role} seat still has no name on it`,
      `A seat without a name cannot be asked a question, chased, or thanked.`,
      `Put their name on the seat.`, { key: s.id, seatId: s.id }));
  }
}

/* ---------- access ---------- */

function accessRisk(state, out) {
  const now = today();
  for (const g of state.access) {
    const acct = db.account(state, g.accountId);
    if (!acct || acct.status === 'archived') continue;

    if (g.status !== 'granted') {
      const waiting = g.requestedOn ? daysBetween(g.requestedOn, now) : null;
      out.push(A('access_blocker', acct.tier === 'flagship' ? 'high' : 'med',
        `${acct.name}: ${g.platform} access is still ${g.status}`,
        `${g.level} has not landed${waiting !== null ? `, ${waiting} days after it was asked for` : ''}. Work can be produced without it; it cannot be published.`,
        `Chase the thread today and hold it until the handover is done. ${g.note || ''}`.trim(),
        { key: g.id, accessId: g.id, accountId: acct.id }));
      continue;
    }

    if (g.expiresOn) {
      const left = daysBetween(now, g.expiresOn);
      if (left <= 21) {
        out.push(A('access_expiring', left <= 7 ? 'high' : 'med',
          `${acct.name}: ${g.platform} access ${left < 0 ? `expired ${-left} days ago` : `expires in ${left} days`}`,
          `${g.level}${g.account ? ` on ${g.account}` : ''}, expiring ${g.expiresOn}. Meta invites lapse silently and the first sign is a failed post.`,
          `Re-invite before the date. Doing it after means walking the client through page settings again.`,
          { key: g.id, accessId: g.id, accountId: acct.id, daysLeft: left }));
      }
    }

    if (g.holder === 'personal') {
      out.push(A('access_personal', 'med',
        `${acct.name}: ${g.platform} access sits on a personal login`,
        `${g.level} is held on ${g.account || 'a personal account'} rather than the agency one. The access leaves when the person does, and it cannot be handed to a new hire.`,
        `Re-grant to ${state.org.email} and remove the personal grant once it is confirmed.`,
        { key: g.id, accessId: g.id, accountId: acct.id }));
    }
    if (g.holder === 'shared') {
      out.push(A('access_shared', 'low',
        `${acct.name}: ${g.platform} runs on a shared login`,
        `A shared password is a single point of failure that rotates without warning and cannot be audited.`,
        `Fine for now. Move to proper delegated access the next time the client is on a call.`,
        { key: g.id, accessId: g.id, accountId: acct.id }));
    }
  }
}

/* ---------- the gate ---------- */

function gateHealth(state, out) {
  const now = today();
  const waiting = state.jobs.filter((j) => j.state === 'gate');
  const byKeeper = new Map();
  for (const j of waiting) {
    const acct = db.account(state, j.accountId);
    if (!acct || !acct.gatekeeperId) continue;
    const list = byKeeper.get(acct.gatekeeperId) || [];
    list.push(j);
    byKeeper.set(acct.gatekeeperId, list);
  }
  for (const [keeperId, jobs] of byKeeper) {
    const oldest = jobs.reduce((n, j) => Math.min(n, daysBetween(j.touchedOn || j.createdOn, now) * -1), 0) * -1;
    if (jobs.length >= 8 || oldest >= 2) {
      out.push(A('gate_backlog', jobs.length >= 15 || oldest >= 4 ? 'high' : 'med',
        `${jobs.length} deliverables are queued at ${db.seatName(state, keeperId)}’s gate`,
        `Oldest has been sitting ${oldest} day${oldest === 1 ? '' : 's'}. The gate is the only thing standing between a rough cut and a client account, and a queue at it stops every account behind it at once.`,
        `Clear the queue before taking on anything new today, or hand the gate to a deputy for the day and say so out loud.`,
        { key: keeperId, seatId: keeperId, count: jobs.length }));
    }
  }

  const keepers = new Set(state.accounts.filter((a) => a.gateRequired && a.gatekeeperId).map((a) => a.gatekeeperId));
  for (const k of keepers) {
    const seat = db.seat(state, k);
    if (seat && !seat.deputyId) {
      const accts = state.accounts.filter((a) => a.gatekeeperId === k).map((a) => a.name);
      out.push(A('gate_no_deputy', 'med',
        `${db.seatName(state, k)} is the only gate on ${accts.length} accounts and has no deputy`,
        `${accts.join(', ')} all stop the day this person is unavailable. A part-time seat with a hard gate on the flagship is a scheduling risk, not a staffing one.`,
        `Name a deputy who can clear the gate on a stated day, and write down what they are allowed to wave through.`,
        { key: k, seatId: k }));
    }
  }
}

/* ---------- delivery against what was promised ---------- */

function cadenceGap(state, day, out) {
  const start = addDays(weekStart(day || today()), -7);
  const end = addDays(start, 6);
  const noBaseline = [];
  for (const acct of state.accounts) {
    if (acct.status === 'archived') continue;
    const lines = state.workLines.filter((wl) => wl.accountId === acct.id && wl.active !== false && wl.route !== 'standing');
    if (!lines.length) continue;
    const promised = Math.round(lines.reduce((n, wl) => n + scheduler.weeklyPromise(wl), 0));
    if (!promised) continue;
    /*
     * No post history at all means the system has not been running long enough to
     * accuse anybody of anything. Measuring starts once there is a first post.
     */
    const everPosted = state.postLog.some((p) => p.accountId === acct.id);
    if (!everPosted) {
      noBaseline.push(acct.name);
      continue;
    }
    const posted = state.postLog.filter((p) => p.accountId === acct.id && p.on >= start && p.on <= end).length;
    const ratio = posted / promised;
    if (ratio >= 0.85) continue;
    /* An account that has not started yet is not behind; it is waiting on access. */
    const blocked = state.access.some((g) => g.accountId === acct.id && g.status !== 'granted');
    if (blocked && posted === 0) continue;
    out.push(A('cadence_gap', ratio < 0.5 ? 'high' : 'med',
      `${acct.name} delivered ${posted} of ${promised} promised posts last week`,
      `That is ${Math.round(ratio * 100)}% of the cadence on the books. A client notices this before you tell them, and by then it is a conversation about competence rather than capacity.`,
      `Either bring the cadence on this account down to what the bench can actually carry, or move work onto a seat with slack. Do it as a decision, in writing, this week.`,
      { key: acct.id, accountId: acct.id, promised, posted }));
  }

  if (noBaseline.length) {
    out.push(A('no_baseline', 'low',
      `No delivery history yet for ${noBaseline.length} account${noBaseline.length === 1 ? '' : 's'}`,
      `${noBaseline.join(', ')}. Promised cadence against delivered cadence is the number that shows a client slipping before they say anything, and it cannot be computed until posts start being marked off here.`,
      `Mark work posted as it goes out — through the board, the CLI or the API. A week of that and this becomes the most useful number on the dashboard.`,
      { key: 'baseline' }));
  }
}

/* ---------- standards ---------- */

function standardsGaps(state, out) {
  const missing = new Map();
  for (const wl of state.workLines) {
    if (wl.active === false || wl.route === 'standing') continue;
    if (wl.standardId) continue;
    const list = missing.get(wl.accountId) || [];
    list.push(wl.title);
    missing.set(wl.accountId, list);
  }
  for (const [accountId, titles] of missing) {
    const acct = db.account(state, accountId);
    out.push(A('standard_missing', acct && acct.tier === 'flagship' ? 'med' : 'low',
      `${db.accountName(state, accountId)} has ${titles.length} work line${titles.length === 1 ? '' : 's'} with no written standard`,
      `${titles.join('; ')}. Whatever "good" means on these lives in somebody's head, which makes every new hire cost what the last one cost.`,
      `Write the checklist once. It does not have to be long, it has to exist.`,
      { key: accountId, accountId }));
  }
  for (const std of state.standards) {
    if (std.status !== 'draft') continue;
    const acct = std.scope && std.scope.startsWith('c_') ? db.account(state, std.scope) : null;
    out.push(A('standard_draft', acct && acct.tier === 'flagship' ? 'high' : 'med',
      `The standard for ${std.name} is still a draft`,
      `${std.note || 'Drafted but not signed off.'} A new manager and a new senior editor arriving in the same month is the point where undocumented taste stops being tolerable.`,
      `Finish it off the first real deliverable, then mark it proven. ${std.owner ? `Owner: ${db.seatName(state, std.owner)}.` : ''}`.trim(),
      { key: std.id, standardId: std.id }));
  }
}

/* ---------- the board itself ---------- */

function jobHealth(state, day, out) {
  const now = day || today();
  const open = pipeline.openJobs(state);

  const late = open.filter((j) => pipeline.isLate(j, now));
  if (late.length) {
    const byAcct = {};
    for (const j of late) byAcct[j.accountId] = (byAcct[j.accountId] || 0) + 1;
    const worst = Object.entries(byAcct).sort((a, b) => b[1] - a[1]);
    out.push(A('late_jobs', late.length >= 10 ? 'high' : 'med',
      `${late.length} deliverables are past their date`,
      worst.map(([id, n]) => `${db.accountName(state, id)}: ${n}`).join(', '),
      `Work the oldest first, and drop anything priority 3 that is more than a week late rather than carrying it forward again.`,
      { key: 'late', count: late.length }));
  }

  const stale = open.filter((j) => daysBetween(j.touchedOn || j.createdOn, now) >= 5);
  if (stale.length) {
    out.push(A('stale_jobs', 'low',
      `${stale.length} deliverables have not moved in five days`,
      `Work that sits still is either blocked and unreported, or it was never really going to happen.`,
      `Block it with a reason or drop it. Leaving it on the board is the worst of the three.`,
      { key: 'stale', count: stale.length }));
  }

  const blocked = state.jobs.filter((j) => j.state === 'blocked');
  if (blocked.length) {
    out.push(A('blocked_jobs', blocked.length >= 5 ? 'med' : 'low',
      `${blocked.length} deliverables are blocked`,
      blocked.slice(0, 5).map((j) => `${db.accountName(state, j.accountId)}: ${(j.blockers.at(-1) || {}).why || 'no reason given'}`).join('; '),
      `Every blocker belongs to somebody. Put a name against each one today.`,
      { key: 'blocked', count: blocked.length }));
  }
}

/* ---------- commercial ---------- */

function commercial(state, day, out) {
  const now = day || today();
  for (const acct of state.accounts) {
    if (acct.reviewDate) {
      const left = daysBetween(now, acct.reviewDate);
      if (left <= 14) {
        out.push(A('account_review', left <= 3 ? 'high' : 'med',
          `${acct.name} hits its re-evaluation on ${acct.reviewDate}`,
          `${left < 0 ? `${-left} days overdue` : `${left} days out`}. ${acct.retainer === 0 ? 'This account is currently paying nothing.' : ''} A trial that drifts past its review date quietly becomes free work.`,
          `Pull the numbers, decide the shape — retainer, revenue split, or a hybrid — and put it to them before the date rather than after.`,
          { key: acct.id, accountId: acct.id }));
      }
    }
    if (acct.billingDay) {
      const dom = dayOfMonth(now);
      const until = acct.billingDay - dom;
      if (until >= 0 && until <= 3) {
        out.push(A('billing_due', 'low',
          `${acct.name} bills on the ${acct.billingDay}${until === 0 ? ' — today' : ` in ${until} days`}`,
          `Recurring retainer${acct.retainer ? ` of ${acct.retainer}` : ''}. Automated in QuickBooks; this is the check that it actually went.`,
          `Confirm the recurring invoice sent, then leave it alone.`,
          { key: acct.id, accountId: acct.id }));
      }
    }
  }
}

/* ---------- decisions that were made and never landed ---------- */

function openDecisions(state, out) {
  const open = state.decisions.filter((d) => d.status === 'open' && (d.kind === 'fix' || d.kind === 'rescope'));
  for (const d of open) {
    out.push(A('decision_open', 'med',
      d.title,
      d.body,
      `Marked as a decision to make, still open. Either do it this week or move it to watch so it stops appearing here.`,
      { key: d.id, decisionId: d.id }));
  }
}

/* ---------- run everything ---------- */

function run(state, day) {
  const out = [];
  overCapacity(state, day, out);
  busFactor(state, out);
  openSeatLoad(state, day, out);
  accessRisk(state, out);
  gateHealth(state, out);
  cadenceGap(state, day, out);
  standardsGaps(state, out);
  jobHealth(state, day, out);
  commercial(state, day, out);
  openDecisions(state, out);
  return out.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.kind.localeCompare(b.kind));
}

function summary(list) {
  return {
    high: list.filter((a) => a.severity === 'high').length,
    med: list.filter((a) => a.severity === 'med').length,
    low: list.filter((a) => a.severity === 'low').length,
    total: list.length,
  };
}

module.exports = { run, summary, SEVERITY_ORDER };
