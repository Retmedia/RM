#!/usr/bin/env node
'use strict';
/*
 * The unattended half. Two jobs, meant for cron:
 *
 *   node automation/run.js daily    every morning — briefs, alerts, a digest
 *   node automation/run.js weekly   Monday — build the week from the commitments
 *
 * Both write markdown into data/briefs/ so the output survives the terminal, and
 * both print to stdout so cron can mail it. If RMOS_WEBHOOK is set, the digest is
 * POSTed there as JSON, which is how this reaches Slack, email or anything else
 * without the system needing to know what any of those are.
 */

const fs = require('node:fs');
const path = require('node:path');

const db = require('../server/db');
const util = require('../server/util');
const scheduler = require('../server/domain/scheduler');
const capacity = require('../server/domain/capacity');
const alerts = require('../server/domain/alerts');
const brief = require('../server/domain/brief');

const mode = process.argv[2] || 'daily';
const day = process.argv[3] || util.today();
const OUT = process.env.RMOS_BRIEFS || path.resolve(__dirname, '..', 'data', 'briefs');

function write(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

async function notify(payload) {
  if (!process.env.RMOS_WEBHOOK) return;
  try {
    const res = await fetch(process.env.RMOS_WEBHOOK, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    console.log(`\nwebhook: ${res.status}`);
  } catch (e) {
    console.error(`\nwebhook failed: ${e.message}`);
  }
}

function markdownPulse(p) {
  const L = [`# RET Media — ${p.on}`, '', `Week ${p.week}. ${p.board.scheduled} scheduled, ${p.board.posted} posted, ${p.board.inGate} at the gate, ${p.board.late} late.`, ''];
  L.push('## Needs a decision today', '');
  for (const a of p.alerts.all.filter((x) => x.severity === 'high')) {
    L.push(`### ${a.title}`, '', a.detail, '', `**Do this:** ${a.action}`, '');
  }
  L.push('## Seats', '', '| Seat | Load | Capacity | Utilisation |', '| --- | --- | --- | --- |');
  for (const s of p.capacity.seats) {
    if (!s.capacityMinutes) continue;
    L.push(`| ${s.name} | ${s.loadHours}h | ${s.capacityHours}h | ${s.utilization}% |`);
  }
  L.push('', '## Accounts', '', '| Account | Owner | Promised/wk | Scheduled | Flags |', '| --- | --- | --- | --- | --- |');
  for (const a of p.accounts) {
    L.push(`| ${a.name} | ${a.owner} | ${a.promisedPerWeek} | ${a.scheduled} | ${a.highAlerts ? `${a.highAlerts} high` : '—'} |`);
  }
  return `${L.join('\n')}\n`;
}

async function daily(state) {
  const p = brief.pulse(state, day);
  const dir = path.join(OUT, day);

  write(path.join(dir, 'pulse.md'), markdownPulse(p));
  for (const seat of state.seats) {
    if (seat.openSeat) continue;
    const b = brief.forSeat(state, seat.id, day);
    write(path.join(dir, `${util.slugify(db.seatName(state, seat.id))}.txt`), `${brief.renderSeatBrief(b)}\n`);
  }

  console.log(brief.renderPulse(p));
  console.log(`\nWritten to ${dir}`);

  await notify({
    kind: 'rmos.daily',
    on: day,
    utilization: p.capacity.totals.utilization,
    high: p.alerts.summary.high,
    late: p.board.late,
    inGate: p.board.inGate,
    headlines: p.alerts.top.map((a) => ({ title: a.title, action: a.action })),
  });
}

async function weekly(state) {
  const r = scheduler.generateWeek(state, day);
  db.save(state);
  const cap = capacity.forWeek(state, day);
  const over = cap.seats.filter((s) => s.utilization > 100);

  console.log(`${r.week}: ${r.created.length} new deliverables scheduled from ${state.workLines.filter((w) => w.active !== false).length} standing commitments.`);
  console.log(`Agency at ${cap.totals.utilization}%.`);

  const lines = [`# Week ${r.week}`, '', `Generated ${util.today()} from ${state.workLines.length} work lines. ${r.created.length} new deliverables.`, ''];

  if (over.length) {
    console.log('');
    console.log('This week does not fit:');
    lines.push('## This week does not fit', '');
    for (const s of over) {
      const relief = capacity.reliefFor(state, s.seatId, day);
      const fix = (relief.accountMoves || []).find((m) => m.solvesIt);
      const msg = `${s.name} at ${s.utilization}% (${s.loadHours}h of ${s.capacityHours}h)`;
      console.log(`  ${msg}`);
      lines.push(`- **${msg}**`);
      if (fix) {
        console.log(`    move ${fix.name} and it lands at ${fix.leavesAt}%`);
        lines.push(`  - Move ${fix.name} off them and the week lands at ${fix.leavesAt}%.`);
      }
      for (const o of relief.recommend.slice(0, 4)) {
        lines.push(`  - Or shed: ${o.account} — ${o.title} (${o.hours}h, priority ${o.priority})`);
      }
    }
    lines.push('');
  } else {
    lines.push('Everything fits in the seats available.', '');
  }

  if (r.skipped.length) {
    lines.push('## Could not be scheduled', '');
    for (const s of r.skipped) lines.push(`- ${s.workLineId} on ${s.dueOn}: ${s.reason}`);
  }

  const file = write(path.join(OUT, `${r.week}.md`), `${lines.join('\n')}\n`);
  console.log(`\nWritten to ${file}`);

  await notify({
    kind: 'rmos.weekly',
    week: r.week,
    created: r.created.length,
    utilization: cap.totals.utilization,
    overloaded: over.map((s) => ({ name: s.name, utilization: s.utilization })),
  });
}

(async () => {
  const state = db.load();
  if (mode === 'daily') await daily(state);
  else if (mode === 'weekly') await weekly(state);
  else {
    console.error(`Unknown mode "${mode}". Use daily or weekly.`);
    process.exit(1);
  }
})();
