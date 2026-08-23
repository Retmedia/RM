'use strict';
const { stableId, weekStart, weekDays, isoWeek, dayName, dayOfMonth, today } = require('../util');
const db = require('../db');
const pipeline = require('./pipeline');

/*
 * The scheduler is the automation. Work lines are promises; this turns them into
 * a week of dated jobs so nobody has to remember what was promised to whom.
 *
 * It is idempotent by construction: every generated job gets an id derived from
 * (work line, day, index), so running it twice on the same week changes nothing
 * and running it after a work line changes only adds what is genuinely new.
 */

function unitsFor(wl, day) {
  const n = wl.perPeriod || 1;
  switch (wl.cadence) {
    case 'daily':
      return n;
    case 'weekdays': {
      const d = dayName(day);
      return d === 'Sat' || d === 'Sun' ? 0 : n;
    }
    case 'weekly':
      return dayName(day) === (wl.anchorDay || 'Mon') ? n : 0;
    case 'monthly':
      return dayOfMonth(day) === (wl.anchorDate || 1) ? n : 0;
    case 'ongoing':
    default:
      return 0; /* standing load, priced by the capacity model, never a dated job */
  }
}

function generateWeek(state, day, opts = {}) {
  const start = weekStart(day || today());
  const days = weekDays(start);
  const week = isoWeek(start);
  const created = [];
  const skipped = [];

  for (const wl of state.workLines) {
    if (wl.active === false) continue;
    if (wl.route === 'standing') continue;
    for (const d of days) {
      const units = unitsFor(wl, d);
      for (let i = 0; i < units; i += 1) {
        const id = stableId('j', wl.id, d, String(i));
        if (db.job(state, id)) continue; /* already generated, leave it exactly as it is */
        try {
          created.push(pipeline.create(state, { workLineId: wl.id, dueOn: d, id }));
        } catch (e) {
          skipped.push({ workLineId: wl.id, dueOn: d, reason: e.message });
        }
      }
    }
  }

  state.generated[week] = {
    weekStart: start,
    generatedOn: today(),
    created: created.length,
    total: state.jobs.filter((j) => j.dueOn >= start && j.dueOn <= days[6]).length,
  };

  return { week, weekStart: start, created, skipped, ...(opts.quiet ? {} : {}) };
}

/* Everything due in the week containing `day`. */
function jobsInWeek(state, day) {
  const start = weekStart(day || today());
  const days = weekDays(start);
  const end = days[6];
  return state.jobs.filter((j) => j.dueOn >= start && j.dueOn <= end);
}

/*
 * What a work line promises per week, in units. Used to compare the promise against
 * the post log, which is how a slipping cadence surfaces before the client notices.
 */
function weeklyPromise(wl) {
  const n = wl.perPeriod || 1;
  switch (wl.cadence) {
    case 'daily': return n * 7;
    case 'weekdays': return n * 5;
    case 'weekly': return n;
    case 'monthly': return (n * 12) / 52;
    default: return 0;
  }
}

module.exports = { generateWeek, jobsInWeek, weeklyPromise, unitsFor };
