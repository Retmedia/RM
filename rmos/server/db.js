'use strict';
const path = require('node:path');
const { writeJSONAtomic, readJSONIfExists } = require('./util');
const { seed } = require('./seed');

/*
 * One JSON document, written atomically. The whole agency is a few hundred
 * records: a database server would be more machinery than the problem deserves,
 * and a single file is something Garrett can open, read, and back up by copying.
 */

const DB_PATH = process.env.RMOS_DB
  ? path.resolve(process.env.RMOS_DB)
  : path.resolve(__dirname, '..', 'data', 'rmos.json');

let cache = null;

function load() {
  if (cache) return cache;
  const onDisk = readJSONIfExists(DB_PATH);
  cache = onDisk ? migrate(onDisk) : seed();
  return cache;
}

function save(state) {
  cache = state || cache;
  writeJSONAtomic(DB_PATH, cache);
  return cache;
}

/* Fill in anything a newer version of the code expects but an older file lacks. */
function migrate(d) {
  const base = seed();
  for (const key of Object.keys(base)) {
    if (d[key] === undefined) d[key] = base[key];
  }
  d.jobs = d.jobs || [];
  d.postLog = d.postLog || [];
  d.generated = d.generated || {};
  for (const j of d.jobs) {
    j.history = j.history || [];
    j.blockers = j.blockers || [];
  }
  return d;
}

/* Reset the in-memory copy. Tests use this; nothing else should. */
function reset(state) {
  cache = state || seed();
  return cache;
}

/* ---------- lookups ---------- */

const byId = (list, id) => list.find((x) => x.id === id) || null;

function seat(state, id) { return byId(state.seats, id); }
function account(state, id) { return byId(state.accounts, id); }
function workLine(state, id) { return byId(state.workLines, id); }
function job(state, id) { return byId(state.jobs, id); }
function standard(state, id) { return byId(state.standards, id); }

/* A seat's display name. Open seats read as the role, which is what you want on a board. */
function seatName(state, id) {
  const s = seat(state, id);
  if (!s) return 'Unassigned';
  if (s.name) return s.name;
  return s.openSeat ? `${s.role} (open)` : `${s.role} (unnamed)`;
}

function accountName(state, id) {
  const a = account(state, id);
  return a ? a.name : 'Unknown account';
}

module.exports = {
  DB_PATH, load, save, reset, migrate,
  seat, account, workLine, job, standard, seatName, accountName,
};
