'use strict';
/*
 * One fetch of /api/state per render, everything drawn from that. The whole
 * dataset is a few hundred records, so partial updates would be complexity
 * bought with nothing.
 */

let S = null;
let view = 'today';
let who = null;

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const h = (n) => Math.round((n / 60) * 10) / 10;

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `request failed: ${res.status}`);
  return data;
}

function toast(msg, bad) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = bad ? 'toast bad' : 'toast';
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { t.hidden = true; }, 3600);
}

async function refresh() {
  S = await api('/api/state');
  if (!who) who = 'p_garrett';
  const sel = $('#who');
  sel.innerHTML = S.seats.map((s) => `<option value="${s.id}"${s.id === who ? ' selected' : ''}>${esc(s.displayName)}</option>`).join('');
  render();
}

/* ---------- helpers shared by views ---------- */

const seatName = (id) => (S.seats.find((s) => s.id === id) || {}).displayName || 'Unassigned';
const acctName = (id) => (S.accounts.find((a) => a.id === id) || {}).name || '—';
const acctColor = (id) => (S.accounts.find((a) => a.id === id) || {}).color || 'indigo';

function utilClass(p) { return p > 100 ? 'over' : p >= 90 ? 'tight' : ''; }

function alertList(list) {
  if (!list.length) return '<p class="empty">Nothing flagged.</p>';
  return list.map((a) => `
    <div class="alert">
      <span class="sev ${a.severity}"></span>
      <div class="body">
        <div class="t">${esc(a.title)}</div>
        <div class="d">${esc(a.detail)}</div>
        <div class="a">${esc(a.action)}</div>
      </div>
    </div>`).join('');
}

/* ---------- today ---------- */

function viewToday() {
  const p = S.pulse;
  const b = S.briefFor;
  const cap = S.capacity;
  const highs = S.alerts.filter((a) => a.severity === 'high');

  return `
  <h1>${esc(p.org.name)}</h1>
  <p class="lede">${p.on} · week ${p.week} · ${p.board.scheduled} deliverables scheduled, ${p.board.posted} posted</p>

  <div class="grid g4" style="margin-top:20px">
    <div class="card stat"><span class="k">Agency load</span><span class="n">${cap.totals.utilization}%</span>
      <span class="sub">${cap.totals.overloaded.length ? `over: ${esc(cap.totals.overloaded.join(', '))}` : 'inside capacity'}</span></div>
    <div class="card stat ${p.board.late ? 'warn' : ''}"><span class="k">Late</span><span class="n">${p.board.late}</span>
      <span class="sub">past their date</span></div>
    <div class="card stat"><span class="k">At the gate</span><span class="n">${p.board.inGate}</span>
      <span class="sub">waiting on review</span></div>
    <div class="card stat ${highs.length ? 'warn' : ''}"><span class="k">Flagged high</span><span class="n">${highs.length}</span>
      <span class="sub">${S.alerts.length} in total</span></div>
  </div>

  <h2>Needs you today</h2>
  <div class="card">${alertList(highs.length ? highs : S.alerts.slice(0, 5))}</div>

  <h2>${esc(seatName(who))}’s day</h2>
  <div class="grid g2">
    <div class="card">
      <h3>Today</h3>
      ${b.dueToday.length
        ? `<table><tbody>${b.dueToday.map((j) => `<tr><td>${esc(j.account)}</td><td>${esc(j.title)}</td><td><span class="pill">${esc(j.stateLabel)}</span></td></tr>`).join('')}</tbody></table>`
        : '<p class="empty">Nothing dated today.</p>'}
      ${b.late.length ? `<p class="faint" style="margin-top:12px">${b.late.length} late, oldest ${esc(b.late[0].dueOn)}.</p>` : ''}
    </div>
    <div class="card">
      <h3>Waiting on them</h3>
      ${b.atMyGate.length
        ? `<p class="faint">${b.atMyGate.length} at their gate. Nothing behind these moves until they clear.</p>
           <table><tbody>${b.atMyGate.slice(0, 8).map((j) => `<tr><td>${esc(j.account)}</td><td>${esc(j.title)}</td></tr>`).join('')}</tbody></table>`
        : '<p class="empty">Nothing queued on them.</p>'}
      ${b.standing.length
        ? `<h3 style="margin-top:16px">Standing</h3><ul class="tick">${b.standing.map((s) => `<li>${esc(s.title)} <span class="faint">${h(s.minutes)}h/wk</span></li>`).join('')}</ul>`
        : ''}
    </div>
  </div>

  <h2>Decisions still open</h2>
  <div class="card">
    <table><tbody>
    ${S.decisions.map((d) => `<tr>
      <td style="width:1%"><span class="pill ${d.status === 'done' ? 'ok' : d.status === 'open' ? 'warn' : ''}">${esc(d.status)}</span></td>
      <td><b>${esc(d.title)}</b><div class="faint">${esc(d.body)}</div></td>
      <td style="width:1%"><button class="btn" data-decide="${d.id}" data-status="${d.status === 'done' ? 'open' : 'done'}">${d.status === 'done' ? 'Reopen' : 'Done'}</button></td>
    </tr>`).join('')}
    </tbody></table>
  </div>`;
}

/* ---------- board ---------- */

function viewBoard() {
  const open = S.jobs.filter((j) => j.state !== 'posted' && j.state !== 'killed');
  const cols = [...S.states, 'blocked'];
  return `
  <h1>The board</h1>
  <p class="lede">${open.length} live deliverables. Click one to move it — the gate only opens for the person who owns it.</p>
  <div class="columns" style="margin-top:18px">
    ${cols.map((st) => {
      const jobs = open.filter((j) => j.state === st).sort((a, b) => a.dueOn.localeCompare(b.dueOn));
      if (!jobs.length && st === 'blocked') return '';
      return `<div class="col">
        <h4><span>${esc(S.stateLabels[st])}</span><span>${jobs.length}</span></h4>
        ${jobs.slice(0, 40).map((j) => `
          <div class="job ${j.dueOn < S.on ? 'late' : ''}" data-job="${j.id}" style="border-left-color:var(--${acctColor(j.accountId)})">
            <div class="jt">${esc(j.title)}</div>
            <div class="jm"><span>${esc(acctName(j.accountId))}</span><span class="due">${esc(j.dueOn)}</span></div>
          </div>`).join('')}
        ${jobs.length > 40 ? `<p class="faint">…and ${jobs.length - 40} more</p>` : ''}
        ${!jobs.length ? '<p class="faint">Empty.</p>' : ''}
      </div>`;
    }).join('')}
  </div>`;
}

/* ---------- capacity ---------- */

function viewCapacity() {
  const cap = S.capacity;
  return `
  <h1>Capacity</h1>
  <p class="lede">Week ${cap.week}, ${cap.weekStart} to ${cap.weekEnd}. Production plus rework plus review — leave any of the three out and the week looks fine until Wednesday.</p>
  <div class="card" style="margin-top:18px">
    ${cap.seats.filter((s) => s.capacityMinutes).map((s) => `
      <div class="seatrow">
        <div class="seatline">
          <b>${esc(s.name)}</b>
          <span class="pcta ${utilClass(s.utilization)}">${s.utilization}%</span>
        </div>
        <div class="bar"><i class="${utilClass(s.utilization)}" style="width:${Math.min(100, s.utilization)}%"></i></div>
        <div class="faint">
          ${s.loadHours}h of ${s.capacityHours}h ·
          production ${h(s.productionMinutes)}h · rework ${h(s.reworkMinutes)}h · review ${h(s.reviewMinutes)}h · standing ${h(s.standingMinutes)}h
        </div>
        <div class="faint">${s.byAccount.map((a) => `${esc(a.name)} ${h(a.minutes)}h`).join(' · ') || 'nothing assigned'}</div>
        ${s.utilization > 100 ? `<button class="btn" style="margin-top:8px" data-relief="${s.seatId}">What to move</button>` : ''}
      </div>`).join('')}
  </div>`;
}

/* ---------- accounts ---------- */

function viewAccounts() {
  return `
  <h1>Accounts</h1>
  <p class="lede">What each client is owed a week, who owns it, and who stands between the work and their feed.</p>
  <div class="card" style="margin-top:18px">
  <table>
    <thead><tr><th>Account</th><th>Owner</th><th>Gate</th><th>Promised</th><th>Scheduled</th><th>Retainer</th><th>Flags</th></tr></thead>
    <tbody>
    ${S.pulse.accounts.map((a) => `<tr>
      <td><b style="color:var(--${acctColor(a.id)})">${esc(a.name)}</b><div class="faint">${esc(a.client)} · ${esc(a.tier)} · ${esc(a.status)}</div></td>
      <td>${esc(a.owner)}</td>
      <td>${a.gate ? esc(a.gate) : '<span class="faint">none</span>'}</td>
      <td>${a.promisedPerWeek}/wk</td>
      <td>${a.scheduled}</td>
      <td>${a.retainer ? `$${a.retainer}` : '<span class="faint">—</span>'}</td>
      <td>${a.highAlerts ? `<span class="pill bad">${a.highAlerts} high</span>` : a.alerts ? `<span class="pill warn">${a.alerts}</span>` : '<span class="pill ok">clear</span>'}</td>
    </tr>`).join('')}
    </tbody>
  </table>
  </div>

  <h2>Work lines</h2>
  <div class="card">
  <table>
    <thead><tr><th>Account</th><th>What</th><th>Owner</th><th>Rhythm</th><th>Route</th><th>Standard</th></tr></thead>
    <tbody>
    ${S.workLines.map((w) => `<tr>
      <td class="faint">${esc(acctName(w.accountId))}</td>
      <td>${esc(w.title)}</td>
      <td>${esc(seatName(w.ownerId))}</td>
      <td>${esc(w.cadence)}${w.perPeriod > 1 ? ` ×${w.perPeriod}` : ''}${w.anchorDay ? ` (${esc(w.anchorDay)})` : ''}</td>
      <td><span class="pill">${esc(w.route)}</span></td>
      <td>${w.standardId ? `<a href="#" data-std="${w.standardId}">${esc(w.standardId)}</a>` : '<span class="pill warn">none</span>'}</td>
    </tr>`).join('')}
    </tbody>
  </table>
  </div>`;
}

/* ---------- access ---------- */

function viewAccess() {
  const holderPill = (g) => {
    if (g.holder === 'agency') return '<span class="pill ok">agency</span>';
    if (g.holder === 'none') return '<span class="pill bad">not held</span>';
    return `<span class="pill warn">${esc(g.holder)}</span>`;
  };
  return `
  <h1>Access</h1>
  <p class="lede">The thing that stops work without ever appearing on a task board. Anything not held by the agency walks out of the door with the person holding it.</p>
  <div class="card" style="margin-top:18px">
  <table>
    <thead><tr><th>Account</th><th>Platform</th><th>Level</th><th>Status</th><th>Held by</th><th>Expires</th><th></th></tr></thead>
    <tbody>
    ${S.access.map((g) => `<tr>
      <td class="faint">${esc(acctName(g.accountId))}</td>
      <td><b>${esc(g.platform)}</b></td>
      <td>${esc(g.level)}</td>
      <td>${g.status === 'granted' ? '<span class="pill ok">granted</span>' : `<span class="pill bad">${esc(g.status)}</span>`}</td>
      <td>${holderPill(g)}${g.account ? `<div class="faint mono">${esc(g.account)}</div>` : ''}</td>
      <td>${g.expiresOn ? esc(g.expiresOn) : '<span class="faint">—</span>'}</td>
      <td>${g.status !== 'granted' ? `<button class="btn" data-grant="${g.id}">Mark granted</button>` : ''}</td>
    </tr>`).join('')}
    </tbody>
  </table>
  </div>`;
}

/* ---------- standards ---------- */

function viewStandards() {
  return `
  <h1>Standards</h1>
  <p class="lede">What "good" means here, written down. Every draft on this page is a hire that will cost what the last one cost.</p>
  <div class="grid g2" style="margin-top:18px">
  ${S.standards.map((s) => `
    <div class="card">
      <h3>${esc(s.name)} <span class="pill ${s.status === 'proven' ? 'ok' : 'warn'}">${esc(s.status)}</span></h3>
      ${s.note ? `<p class="faint">${esc(s.note)}</p>` : ''}
      <ul class="tick">${s.checklist.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
      ${s.titleBank && s.titleBank.length ? `
        <h3 style="margin-top:14px">Proven titles</h3>
        <p class="faint">Reword these. Do not invent phrasing.</p>
        <table><tbody>${s.titleBank.map((t) => `<tr><td class="faint" style="width:1%">${Math.round(t.views / 1e6)}M</td><td>${esc(t.title)}</td></tr>`).join('')}</tbody></table>` : ''}
    </div>`).join('')}
  </div>`;
}

/* ---------- render + events ---------- */

const VIEWS = { today: viewToday, board: viewBoard, capacity: viewCapacity, accounts: viewAccounts, access: viewAccess, standards: viewStandards };

async function render() {
  if (view === 'today') S.briefFor = await api(`/api/brief/${who}`);
  $('#app').innerHTML = VIEWS[view]();
  $$('.tab').forEach((t) => t.classList.toggle('on', t.dataset.view === view));
}

function sheet(html) {
  $('#sheetBody').innerHTML = html;
  $('#sheet').hidden = false;
}

async function openJob(id) {
  const j = S.jobs.find((x) => x.id === id);
  if (!j) return;
  const wl = S.workLines.find((w) => w.id === j.workLineId);
  const acct = S.accounts.find((a) => a.id === j.accountId);
  const route = (S.stateLabels && wl) ? null : null;
  const next = S.states[S.states.indexOf(j.state) + 1];
  const std = j.standardId ? S.standards.find((s) => s.id === j.standardId) : null;

  sheet(`
    <h3>${esc(j.title)}</h3>
    <p class="faint">${esc(acctName(j.accountId))} · due ${esc(j.dueOn)} · ${esc(seatName(j.assigneeId))} · ${j.minutes} minutes</p>
    <p><span class="pill">${esc(S.stateLabels[j.state])}</span>
       ${acct && acct.gateRequired ? `<span class="pill warn">gate: ${esc(seatName(acct.gatekeeperId))}</span>` : ''}</p>
    ${std ? `<h3 style="margin-top:16px">${esc(std.name)}</h3><ul class="tick">${std.checklist.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
    <div style="display:flex;gap:8px;margin-top:18px;flex-wrap:wrap">
      ${next ? `<button class="btn primary" data-move="${j.id}" data-to="${next}">Move to ${esc(S.stateLabels[next])}</button>` : ''}
      ${j.state === 'gate' ? `<button class="btn" data-move="${j.id}" data-to="gate" data-reject="1">Send it back</button>` : ''}
      <button class="btn" data-move="${j.id}" data-to="blocked">Block</button>
    </div>
    <p class="faint" style="margin-top:12px">Moving as <b>${esc(seatName(who))}</b>. Change who you are in the header if that is wrong.</p>
    ${j.history.length ? `<h3 style="margin-top:18px">History</h3>${j.history.map((x) => `<div class="faint">${esc(x.at)} ${esc(S.stateLabels[x.from] || x.from)} → ${esc(S.stateLabels[x.to] || x.to)}${x.by ? ` · ${esc(seatName(x.by))}` : ''}${x.why ? ` · ${esc(x.why)}` : ''}</div>`).join('')}` : ''}
  `);
}

async function openRelief(seatId) {
  const r = await api(`/api/relief/${seatId}`);
  sheet(`
    <h3>${esc(r.name)} is at ${r.utilization}%</h3>
    <p class="faint">Over by ${r.overHours} hours. That gap comes out of quality, out of the weekend, or out of the gate.</p>
    <h3 style="margin-top:16px">Move a whole account off them</h3>
    <table><tbody>${r.accountMoves.map((m) => `<tr>
      <td style="width:1%">${m.solvesIt ? '<span class="pill ok">fixes it</span>' : '<span class="pill">partial</span>'}</td>
      <td><b>${esc(m.name)}</b>${m.note ? `<div class="faint">${esc(m.note)}</div>` : ''}</td>
      <td class="nowrap faint">${m.movableHours}h movable &middot; ${m.leavesAt}%</td>
    </tr>`).join('')}</tbody></table>
    <h3 style="margin-top:16px">Or shed work, lowest value first</h3>
    <table><tbody>${r.recommend.map((o) => `<tr>
      <td style="width:1%"><span class="pill">p${o.priority}</span></td>
      <td>${esc(o.account)} — ${esc(o.title)}</td><td class="nowrap faint">${o.hours}h</td>
    </tr>`).join('')}</tbody></table>
    ${r.absorbers.length ? `<p class="faint" style="margin-top:14px">Who has room: ${r.absorbers.map((a) => `${esc(a.name)} ${a.slackHours}h`).join(' · ')}</p>` : ''}
  `);
}

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-view],[data-job],[data-move],[data-relief],[data-grant],[data-decide],[data-std]');
  if (!t) return;

  try {
    if (t.dataset.view) { view = t.dataset.view; return render(); }
    if (t.dataset.job) return openJob(t.dataset.job);
    if (t.dataset.relief) return openRelief(t.dataset.relief);
    if (t.dataset.std) {
      e.preventDefault();
      const s = S.standards.find((x) => x.id === t.dataset.std);
      return sheet(`<h3>${esc(s.name)}</h3><p class="faint">${esc(s.note || '')}</p><ul class="tick">${s.checklist.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>`);
    }
    if (t.dataset.move) {
      const body = { to: t.dataset.to, actor: who };
      if (t.dataset.reject) { body.verdict = 'reject'; body.why = prompt('What sends it back?') || 'sent back'; }
      if (t.dataset.to === 'blocked') { body.why = prompt('What is blocking it?') || 'blocked'; }
      await api(`/api/jobs/${t.dataset.move}/move`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      $('#sheet').hidden = true;
      toast('Moved.');
      return refresh();
    }
    if (t.dataset.grant) {
      await api(`/api/access/${t.dataset.grant}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'granted', holder: 'agency', account: S.org.email }),
      });
      toast('Access recorded.');
      return refresh();
    }
    if (t.dataset.decide) {
      await api(`/api/decisions/${t.dataset.decide}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: t.dataset.status }),
      });
      return refresh();
    }
  } catch (err) {
    toast(err.message, true);
  }
});

$('#sheetClose').addEventListener('click', () => { $('#sheet').hidden = true; });
$('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') $('#sheet').hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#sheet').hidden = true; });
$('#who').addEventListener('change', (e) => { who = e.target.value; render(); });
$('#genweek').addEventListener('click', async () => {
  try {
    const r = await api('/api/week', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    toast(`${r.week}: ${r.created} new deliverables scheduled.`);
    refresh();
  } catch (err) { toast(err.message, true); }
});

refresh().catch((e) => { $('#app').innerHTML = `<p class="empty">Could not load: ${esc(e.message)}</p>`; });
