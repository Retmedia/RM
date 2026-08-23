#!/usr/bin/env node
'use strict';
const path = require('node:path');
const fs = require('node:fs');

const db = require('../server/db');
const util = require('../server/util');
const pipeline = require('../server/domain/pipeline');
const scheduler = require('../server/domain/scheduler');
const capacity = require('../server/domain/capacity');
const alerts = require('../server/domain/alerts');
const brief = require('../server/domain/brief');

/* ---------- tiny arg parsing, no dependencies ---------- */

const argv = process.argv.slice(2);
const flags = {};
const args = [];
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    if (v !== undefined) flags[k] = v;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) { flags[k] = argv[i + 1]; i += 1; }
    else flags[k] = true;
  } else args.push(a);
}

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = c(1); const dim = c(2); const red = c(31); const yellow = c(33);
const green = c(32); const cyan = c(36);
const sev = { high: red, med: yellow, low: dim };

const when = () => flags.for || flags.on || util.today();

/* ---------- fuzzy lookup, so you can type "olivia" ---------- */

function findSeat(state, q) {
  if (!q) return null;
  const s = String(q).toLowerCase();
  return state.seats.find((x) => x.id === q)
    || state.seats.find((x) => (x.name || '').toLowerCase() === s)
    || state.seats.find((x) => (x.name || '').toLowerCase().startsWith(s))
    || state.seats.find((x) => (x.role || '').toLowerCase().includes(s))
    || null;
}

function findAccount(state, q) {
  if (!q) return null;
  const s = String(q).toLowerCase();
  return state.accounts.find((x) => x.id === q)
    || state.accounts.find((x) => x.name.toLowerCase() === s)
    || state.accounts.find((x) => x.name.toLowerCase().includes(s))
    || state.accounts.find((x) => (x.client || '').toLowerCase().includes(s))
    || null;
}

/* ---------- commands ---------- */

const commands = {};

commands.init = (state) => {
  if (fs.existsSync(db.DB_PATH) && !flags.force) {
    console.log(`${db.DB_PATH} already exists. Use --force to overwrite it (this erases the board).`);
    return;
  }
  db.save(db.reset());
  const s = db.load();
  console.log(`Wrote ${db.DB_PATH}`);
  console.log(`${s.seats.length} seats · ${s.accounts.length} accounts · ${s.workLines.length} work lines · ${s.access.length} access grants · ${s.standards.length} standards`);
  console.log(dim('Next: rmos week   — build this week from the standing commitments'));
};

commands.pulse = (state) => {
  console.log(brief.renderPulse(brief.pulse(state, when())));
};

commands.brief = (state) => {
  const who = args[1];
  if (!who) {
    for (const s of state.seats) {
      if (s.openSeat) continue;
      console.log(brief.renderSeatBrief(brief.forSeat(state, s.id, when())));
      console.log('');
    }
    return;
  }
  const seat = findSeat(state, who);
  if (!seat) return fail(`No seat matching "${who}".`);
  console.log(brief.renderSeatBrief(brief.forSeat(state, seat.id, when())));
};

commands.week = (state) => {
  const r = scheduler.generateWeek(state, when());
  db.save(state);
  console.log(`${r.week} (from ${r.weekStart}) — ${green(`${r.created.length} new`)} deliverable${r.created.length === 1 ? '' : 's'} scheduled.`);
  if (r.skipped.length) {
    console.log(yellow(`${r.skipped.length} skipped:`));
    for (const s of r.skipped) console.log(`  · ${s.workLineId} ${s.dueOn}: ${s.reason}`);
  }
  const cap = capacity.forWeek(state, r.weekStart);
  const over = cap.seats.filter((x) => x.utilization > 100);
  if (over.length) {
    console.log('');
    console.log(red('This week does not fit:'));
    for (const o of over) {
      const relief = capacity.reliefFor(state, o.seatId, r.weekStart);
      const fix = (relief.accountMoves || []).find((m) => m.solvesIt);
      console.log(`  ${o.name} at ${o.utilization}% (${o.loadHours}h of a ${o.capacityHours}h week)`);
      if (fix) console.log(dim(`    move ${fix.name} off them and it lands at ${fix.leavesAt}%`));
    }
    console.log(dim('  rmos relief <seat> for the full list of options'));
  }
};

commands.board = (state) => {
  const acct = flags.account ? findAccount(state, flags.account) : null;
  const seat = flags.owner ? findSeat(state, flags.owner) : null;
  if (flags.account && !acct) return fail(`No account matching "${flags.account}".`);
  if (flags.owner && !seat) return fail(`No seat matching "${flags.owner}".`);

  let jobs = flags.all ? state.jobs : pipeline.openJobs(state);
  if (acct) jobs = jobs.filter((j) => j.accountId === acct.id);
  if (seat) jobs = jobs.filter((j) => j.assigneeId === seat.id);
  if (flags.state) jobs = jobs.filter((j) => j.state === flags.state);
  if (flags.week) {
    const start = util.weekStart(when());
    const end = util.weekDays(start)[6];
    jobs = jobs.filter((j) => j.dueOn >= start && j.dueOn <= end);
  }

  if (!jobs.length) return console.log('Nothing on the board for that.');

  const order = [...pipeline.STATES, 'blocked', 'killed'];
  const groups = new Map();
  for (const j of jobs) {
    const g = groups.get(j.state) || [];
    g.push(j);
    groups.set(j.state, g);
  }
  for (const st of order) {
    const g = groups.get(st);
    if (!g) continue;
    console.log(bold(`${pipeline.STATE_LABELS[st]}  (${g.length})`));
    for (const j of g.sort((a, b) => a.dueOn.localeCompare(b.dueOn))) {
      const late = pipeline.isLate(j, when()) ? red(' LATE') : '';
      console.log(`  ${dim(j.id.padEnd(18))} ${j.dueOn}  ${db.accountName(state, j.accountId).padEnd(16)} ${j.title.slice(0, 52).padEnd(52)} ${dim(db.seatName(state, j.assigneeId))}${late}`);
    }
    console.log('');
  }
};

commands.move = (state) => {
  const [, jobId, next] = args;
  if (!jobId || !next) return fail('Usage: rmos move <jobId> <state> [--as <seat>] [--why "..."] [--reject]');
  const actor = flags.as ? findSeat(state, flags.as) : null;
  if (flags.as && !actor) return fail(`No seat matching "${flags.as}".`);
  const r = pipeline.transition(state, jobId, next, {
    actor: actor ? actor.id : undefined,
    why: typeof flags.why === 'string' ? flags.why : '',
    verdict: flags.reject ? 'reject' : undefined,
  });
  if (!r.ok) return fail(r.reason);
  db.save(state);
  console.log(`${green('ok')} ${jobId}: ${pipeline.STATE_LABELS[r.from]} -> ${bold(pipeline.STATE_LABELS[r.to])}`);
};

commands.post = (state) => {
  const jobId = args[1];
  if (!jobId) return fail('Usage: rmos post <jobId> [--as <seat>]');
  const actor = flags.as ? findSeat(state, flags.as) : null;
  const r = pipeline.transition(state, jobId, 'posted', { actor: actor ? actor.id : undefined });
  if (!r.ok) return fail(r.reason);
  db.save(state);
  console.log(`${green('posted')} ${jobId} — ${db.accountName(state, r.job.accountId)}`);
};

commands.alerts = (state) => {
  let list = alerts.run(state, when());
  if (flags.severity) list = list.filter((a) => a.severity === flags.severity);
  if (flags.kind) list = list.filter((a) => a.kind === flags.kind);
  if (!list.length) return console.log(green('Nothing flagged.'));
  const s = alerts.summary(list);
  console.log(`${s.high} high · ${s.med} medium · ${s.low} low`);
  console.log('');
  for (const a of list) {
    console.log(`${sev[a.severity](`[${a.severity}]`)} ${bold(a.title)}`);
    console.log(`  ${a.detail}`);
    console.log(`  ${cyan('->')} ${a.action}`);
    console.log('');
  }
};

commands.capacity = (state) => {
  const cap = capacity.forWeek(state, when());
  console.log(bold(`${cap.week}  ${cap.weekStart} -> ${cap.weekEnd}`));
  console.log(`Agency at ${cap.totals.utilization}% · ${cap.totals.jobCount} deliverables scheduled`);
  console.log('');
  for (const s of cap.seats) {
    if (!s.capacityMinutes) continue;
    const paint = s.utilization > 100 ? red : s.utilization >= 90 ? yellow : green;
    console.log(`${paint(String(s.utilization).padStart(4) + '%')}  ${bold(s.name.padEnd(26))} ${s.loadHours}h of ${s.capacityHours}h`);
    console.log(dim(`       production ${util.hours(s.productionMinutes)}h · rework ${util.hours(s.reworkMinutes)}h · review ${util.hours(s.reviewMinutes)}h · standing ${util.hours(s.standingMinutes)}h`));
    if (s.byAccount.length) {
      console.log(dim(`       ${s.byAccount.map((a) => `${a.name} ${util.hours(a.minutes)}h`).join(' · ')}`));
    }
  }
};

commands.relief = (state) => {
  const seat = findSeat(state, args[1]);
  if (!seat) return fail('Usage: rmos relief <seat>');
  const r = capacity.reliefFor(state, seat.id, when());
  if (!r.recommend) return console.log(green(`${db.seatName(state, seat.id)} is inside capacity this week.`));
  console.log(bold(`${r.name} is at ${r.utilization}%, over by ${r.overHours}h`));
  console.log('');
  console.log(bold('Move a whole account off them'));
  for (const m of r.accountMoves) {
    const tag = m.solvesIt ? green('fixes it') : dim('partial ');
    console.log(`  ${tag}  ${m.name.padEnd(18)} ${String(m.hours).padStart(5)}h  -> leaves them at ${m.leavesAt}%`);
    if (m.note) console.log(dim(`            ${m.note}`));
  }
  console.log('');
  console.log(bold('Or shed work lines, lowest value first'));
  for (const o of r.recommend) {
    console.log(`  · [p${o.priority}] ${o.account} — ${o.title} ${dim(`${o.hours}h`)}`);
  }
  if (r.absorbers.length) {
    console.log('');
    console.log(dim(`Who has room: ${r.absorbers.map((a) => `${a.name} ${a.slackHours}h`).join(' · ')}`));
  }
};

commands.access = (state) => {
  const rows = [...state.access].sort((a, b) => a.accountId.localeCompare(b.accountId));
  let lastAcct = null;
  for (const g of rows) {
    if (g.accountId !== lastAcct) {
      console.log('');
      console.log(bold(db.accountName(state, g.accountId)));
      lastAcct = g.accountId;
    }
    const holder = g.holder === 'agency' ? green('agency')
      : g.holder === 'personal' ? yellow('personal')
        : g.holder === 'shared' ? yellow('shared')
          : red('none');
    const status = g.status === 'granted' ? green(g.status) : red(g.status);
    const exp = g.expiresOn ? ` expires ${g.expiresOn} (${util.daysBetween(when(), g.expiresOn)}d)` : '';
    console.log(`  ${g.platform.padEnd(22)} ${g.level.padEnd(20)} ${status.padEnd(12)} ${holder}${exp}`);
    if (g.account) console.log(dim(`    on ${g.account}`));
    if (g.note) console.log(dim(`    ${g.note}`));
  }
};

commands.standard = (state) => {
  const q = args[1];
  if (!q) {
    for (const s of state.standards) {
      const status = s.status === 'proven' ? green(s.status) : yellow(s.status);
      console.log(`${s.id.padEnd(22)} ${status.padEnd(12)} ${s.name}`);
    }
    return;
  }
  const std = state.standards.find((s) => s.id === q || s.name.toLowerCase().includes(String(q).toLowerCase()));
  if (!std) return fail(`No standard matching "${q}".`);
  console.log(`${bold(std.name)}  ${std.status === 'proven' ? green(std.status) : yellow(std.status)}`);
  if (std.note) console.log(dim(std.note));
  console.log('');
  for (const item of std.checklist) console.log(`  [ ] ${item}`);
  if (std.titleBank && std.titleBank.length) {
    console.log('');
    console.log(bold('Proven titles — reword these, do not invent'));
    for (const t of std.titleBank) {
      console.log(`  ${String(`${Math.round(t.views / 1e6)}M`).padStart(6)}  ${t.title}`);
    }
  }
};

commands.accounts = (state) => {
  const p = brief.pulse(state, when());
  for (const a of p.accounts) {
    console.log(`${bold(a.name.padEnd(18))} ${a.tier.padEnd(12)} ${a.status.padEnd(11)} owner ${a.owner}`);
    console.log(dim(`  ${a.promisedPerWeek}/wk promised · ${a.scheduled} scheduled this week · gate ${a.gate || 'none'}${a.retainer ? ` · ${util.money(a.retainer)}/mo` : ''}`) + (a.highAlerts ? red(` · ${a.highAlerts} high alerts`) : ''));
  }
};

commands.seats = (state) => {
  const cap = capacity.forWeek(state, when());
  for (const s of state.seats) {
    const row = cap.seats.find((r) => r.seatId === s.id);
    const tags = [
      s.openSeat ? red('OPEN SEAT') : null,
      s.locked ? dim('locked') : null,
      s.onlyAccounts && s.onlyAccounts.length ? dim(`capped to ${s.onlyAccounts.map((a) => db.accountName(state, a)).join(', ')}`) : null,
      (s.backupFor || []).length ? cyan(`backup on ${s.backupFor.map((a) => db.accountName(state, a)).join(', ')}`) : null,
    ].filter(Boolean);
    console.log(`${bold(db.seatName(state, s.id).padEnd(26))} ${s.role.padEnd(20)} ${row ? `${row.utilization}%` : ''} ${tags.join(' · ')}`);
    if (s.reportsTo) console.log(dim(`  reports to ${db.seatName(state, s.reportsTo)}`));
  }
};

commands.decide = (state) => {
  const [, id, status] = args;
  if (!id) {
    for (const d of state.decisions) {
      const mark = d.status === 'done' ? green('done') : d.status === 'watch' ? dim('watch') : yellow('open');
      console.log(`${d.id.padEnd(4)} ${mark.padEnd(12)} ${d.title}`);
    }
    return;
  }
  const d = state.decisions.find((x) => x.id === id);
  if (!d) return fail(`No decision ${id}.`);
  if (!status) {
    console.log(bold(d.title));
    console.log(d.body);
    return;
  }
  if (!['open', 'done', 'watch'].includes(status)) return fail('Status must be open, done or watch.');
  d.status = status;
  d.decidedOn = util.today();
  db.save(state);
  console.log(`${d.id} -> ${status}`);
};

commands.doctor = (state) => {
  const problems = [];
  const seatIds = new Set(state.seats.map((s) => s.id));
  const acctIds = new Set(state.accounts.map((a) => a.id));
  const stdIds = new Set(state.standards.map((s) => s.id));
  const wlIds = new Set(state.workLines.map((w) => w.id));

  for (const s of state.seats) {
    if (s.reportsTo && !seatIds.has(s.reportsTo)) problems.push(`seat ${s.id} reports to a seat that does not exist: ${s.reportsTo}`);
    for (const a of s.onlyAccounts || []) if (!acctIds.has(a)) problems.push(`seat ${s.id} is capped to an unknown account: ${a}`);
  }
  for (const a of state.accounts) {
    if (a.gateRequired && !seatIds.has(a.gatekeeperId)) problems.push(`account ${a.id} needs a gate but its gatekeeper does not exist`);
    if (!seatIds.has(a.ownerId)) problems.push(`account ${a.id} has an unknown owner`);
  }
  for (const w of state.workLines) {
    if (!acctIds.has(w.accountId)) problems.push(`work line ${w.id} points at an unknown account`);
    if (!seatIds.has(w.ownerId)) problems.push(`work line ${w.id} points at an unknown seat`);
    if (w.standardId && !stdIds.has(w.standardId)) problems.push(`work line ${w.id} points at an unknown standard`);
    if (w.dependsOn && !wlIds.has(w.dependsOn)) problems.push(`work line ${w.id} depends on an unknown work line`);
    const assign = pipeline.canAssign(state, w.ownerId, w.accountId);
    if (!assign.ok) problems.push(`work line ${w.id}: ${assign.reason}`);
    if (!pipeline.ROUTES[w.route]) problems.push(`work line ${w.id} has an unknown route: ${w.route}`);
  }
  for (const j of state.jobs) {
    if (!wlIds.has(j.workLineId)) problems.push(`job ${j.id} points at a work line that no longer exists`);
    if (!seatIds.has(j.assigneeId)) problems.push(`job ${j.id} is assigned to a seat that does not exist`);
  }
  for (const s of state.seats) {
    const seen = new Set();
    let cur = s.reportsTo;
    while (cur) {
      if (seen.has(cur)) { problems.push(`reporting line loops at ${s.id}`); break; }
      seen.add(cur);
      const nxt = db.seat(state, cur);
      cur = nxt ? nxt.reportsTo : null;
    }
  }

  if (!problems.length) {
    console.log(green('Everything checks out.'));
    console.log(dim(`${state.seats.length} seats · ${state.accounts.length} accounts · ${state.workLines.length} work lines · ${state.jobs.length} jobs · ${state.postLog.length} posts logged`));
    console.log(dim(`store: ${db.DB_PATH}`));
    return;
  }
  console.log(red(`${problems.length} problem${problems.length === 1 ? '' : 's'}:`));
  for (const p of problems) console.log(`  · ${p}`);
  process.exitCode = 1;
};

commands.serve = () => {
  require('../server/server.js');
};

commands.help = () => {
  console.log(`${bold('rmos')} — the RET Media operating system

${bold('Every day')}
  rmos pulse                     the founder view: what needs you, in order
  rmos brief <who>               one person's day. Omit the name for everybody
  rmos board --owner viktor      the live board, filtered
  rmos alerts --severity high    what is actually on fire

${bold('Running the week')}
  rmos week [--for DATE]         turn the standing commitments into dated work
  rmos capacity                  does the week fit in the seats we have
  rmos relief <seat>             what to move when it does not

${bold('Moving work')}
  rmos move <job> <state> [--as <seat>] [--why "..."] [--reject]
  rmos post <job> --as <seat>    mark it published and log the delivery

${bold('The reference')}
  rmos accounts | seats | access | standard [id] | decide [id] [status]

${bold('Housekeeping')}
  rmos init [--force]            write the starting state to disk
  rmos doctor                    check the whole store for contradictions
  rmos serve                     the dashboard on http://localhost:3940

States: ${pipeline.STATES.join(' -> ')}   (also blocked, killed)
Store:  ${db.DB_PATH}`);
};

function fail(msg) {
  console.error(red(msg));
  process.exitCode = 1;
}

/* ---------- go ---------- */

const name = args[0] || 'pulse';
const cmd = commands[name] || (name === '--help' || name === '-h' ? commands.help : null);
if (!cmd) {
  fail(`Unknown command "${name}".`);
  commands.help();
} else {
  const state = db.load();
  cmd(state);
}
