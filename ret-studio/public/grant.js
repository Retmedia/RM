/* Grant page. One job: let a creator connect their own accounts from their own phone. */

const token = new URLSearchParams(location.search).get('t') || '';
const $ = (id) => document.getElementById(id);

const CADENCE_LABEL = {
  daily: 'every day',
  weekdays: 'weekdays',
  three: '3× a week',
  two: '2× a week',
  off: 'paused'
};

let state = null;
let draft = { cadence: 'weekdays', time: '09:00', routes: [] };

/* ---------- plumbing ---------- */

async function api(path, body) {
  const res = await fetch(path, body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : {});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Try again in a moment.');
  return data;
}

const el = (tag, props = {}, kids = []) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const kid of [].concat(kids)) node.append(kid);
  return node;
};

/* ---------- accounts ---------- */

function connectedIds() {
  return state.platforms.filter((p) => p.account.state === 'connected').map((p) => p.id);
}

function renderProgress() {
  const done = connectedIds().length;
  const total = state.platforms.length;
  $('bar').style.width = `${(done / total) * 100}%`;
  $('count').textContent = `${done} of ${total}`;
}

function accountCard(p) {
  const connected = p.account.state === 'connected';
  const card = el('article', { className: `acct${connected ? ' is-connected is-compact' : ''}` });
  card.style.setProperty('--brand', p.color);

  // Connected accounts shrink to one line. Nothing left to decide, so nothing left to read.
  if (connected) {
    card.append(el('div', { className: 'acct-top' }, [
      el('span', { className: 'dot' }),
      el('div', {}, [
        el('h2', { textContent: p.name }),
        el('p', {
          className: 'acct-sub',
          textContent: p.account.handle ? `Posting as @${p.account.handle}` : 'Connected'
        })
      ]),
      el('button', {
        className: 'btn-text',
        textContent: 'Disconnect',
        onclick: () => disconnect(p, card)
      })
    ]));
    return card;
  }

  card.append(el('div', { className: 'acct-top' }, [
    el('span', { className: 'dot' }),
    el('div', {}, [
      el('h2', { textContent: p.name }),
      el('p', { className: 'acct-sub', textContent: p.sub })
    ]),
    el('span', { className: 'badge', textContent: p.live ? 'Not connected' : 'Setup' })
  ]));

  const btn = el('button', {
    className: 'btn btn-go',
    textContent: `Connect ${p.name}`,
    onclick: () => connect(p, card, btn)
  });
  card.append(el('div', { className: 'acct-actions' }, [btn]));

  // YouTube is the one that trips people up: Google only ever hands over the channel
  // belonging to whoever taps Allow. Say it once, plainly, before they hit the wall.
  if (p.ownerOnly) {
    card.append(el('details', { className: 'why' }, [
      el('summary', { textContent: 'Who has to tap this?' }),
      el('div', {}, [
        el('p', { textContent:
          'Google only gives access to the channel of whoever taps Allow. A Studio Editor usually cannot finish this step.' }),
        el('p', { textContent:
          'If you are not the owner or a manager, forward this link to whoever is, or add info@retmediaagency.com as a Manager in YouTube Studio and tell us.' })
      ])
    ]));
  }

  return card;
}

function renderSetupBanner() {
  const waiting = state.platforms.filter((p) => !p.live);
  const banner = $('setup');
  banner.hidden = waiting.length === 0;
  if (!waiting.length) return;
  const names = waiting.map((p) => p.name).join(', ');
  banner.textContent =
    `Setup mode for ${names}. Your choices save right now. Once each app finishes reviewing ${state.brand}, ` +
    `we will send you one link to confirm for real.`;
}

function renderAccounts() {
  renderSetupBanner();
  const host = $('accounts');
  host.textContent = '';
  for (const p of state.platforms) host.append(accountCard(p));
  renderProgress();
  renderPlan();
}

async function connect(p, card, btn) {
  card.querySelector('.acct-err')?.remove();
  btn.disabled = true;
  btn.textContent = `Opening ${p.name}…`;
  try {
    const out = await api('/api/grant/connect', { t: token, platform: p.id });
    if (out.mode === 'live' && out.authUrl) {
      window.location.href = out.authUrl;
      return;
    }
    p.account = out.account;
    renderAccounts();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = `Connect ${p.name}`;
    card.append(el('p', { className: 'acct-err', textContent: err.message }));
  }
}

async function disconnect(p, card) {
  try {
    const out = await api('/api/grant/disconnect', { t: token, platform: p.id });
    p.account = { state: 'idle', handle: '', connectedAt: null, mode: null };
    draft.routes = out.plan.routes;
    renderAccounts();
  } catch (err) {
    card.append(el('p', { className: 'acct-err', textContent: err.message }));
  }
}

/* ---------- plan ---------- */

const hasRoute = (from, to) => draft.routes.some((r) => r.from === from && r.to === to);

function toggleRoute(from, to, on) {
  draft.routes = draft.routes.filter((r) => !(r.from === from && r.to === to));
  if (on) draft.routes.push({ from, to });
}

function renderRoutes() {
  const host = $('routes');
  host.textContent = '';
  const live = connectedIds();

  if (live.length < 2) {
    host.append(el('p', {
      className: 'small dim',
      textContent: 'Connect two accounts above and you can send clips between them.'
    }));
    return;
  }

  for (const from of live) {
    const src = state.platforms.find((p) => p.id === from);
    const row = el('div', { className: 'route-row' });
    row.append(el('p', {}, ['When you post on ', el('b', { textContent: src.name })]));

    const chips = el('div', { className: 'chips' });
    for (const to of live) {
      if (to === from) continue;
      const dest = state.platforms.find((p) => p.id === to);
      const chip = el('button', {
        type: 'button',
        className: 'chip',
        textContent: `Send to ${dest.name}`
      });
      chip.style.setProperty('--brand', dest.color);
      chip.setAttribute('aria-pressed', String(hasRoute(from, to)));
      chip.onclick = () => {
        const next = chip.getAttribute('aria-pressed') !== 'true';
        chip.setAttribute('aria-pressed', String(next));
        toggleRoute(from, to, next);
        $('planMsg').textContent = '';
      };
      chips.append(chip);
    }
    row.append(chips);
    host.append(row);
  }
}

function renderPlan() {
  const any = connectedIds().length > 0;
  $('plan').hidden = !any;
  if (!any) return;

  for (const btn of $('cadence').querySelectorAll('button')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.cadence === draft.cadence));
  }
  $('time').value = draft.time;
  renderRoutes();
}

async function savePlan() {
  const btn = $('savePlan');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    draft.time = $('time').value || '09:00';
    const out = await api('/api/grant/plan', {
      t: token,
      cadence: draft.cadence,
      time: draft.time,
      routes: draft.routes
    });
    draft = { ...draft, ...out.plan };
    const count = out.plan.routes.length;
    $('planMsg').textContent = count
      ? `Saved. We'll post ${CADENCE_LABEL[out.plan.cadence]} at ${out.plan.time}, across ${count} ${count === 1 ? 'route' : 'routes'}.`
      : `Saved. We'll post ${CADENCE_LABEL[out.plan.cadence]} at ${out.plan.time}.`;
  } catch (err) {
    $('planMsg').textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save my schedule';
  }
}

/* ---------- boot ---------- */

async function boot() {
  if (!token) {
    $('loading').hidden = true;
    $('dead').hidden = false;
    return;
  }
  try {
    state = await api(`/api/grant?t=${encodeURIComponent(token)}`);
  } catch {
    $('loading').hidden = true;
    $('dead').hidden = false;
    return;
  }

  draft = { ...draft, ...state.plan };

  document.title = `Connect your accounts · ${state.brand}`;
  $('brandMark').textContent = state.brand;
  $('title').textContent = `Hi ${state.creator.firstName}, let's connect your accounts`;
  $('lede').textContent =
    `${state.brand} posts your clips for you. Tap Connect on each account you want handled. Takes about a minute.`;
  $('tzNote').textContent = `Times are in your timezone (${state.creator.timezone.replace('_', ' ')}).`;
  $('footBrand').textContent = `${state.brand} · sent to ${state.creator.name}`;

  $('loading').hidden = true;
  $('live').hidden = false;

  for (const btn of $('cadence').querySelectorAll('button')) {
    btn.onclick = () => {
      draft.cadence = btn.dataset.cadence;
      renderPlan();
      $('planMsg').textContent = '';
    };
  }
  $('savePlan').onclick = savePlan;
  $('time').onchange = () => { $('planMsg').textContent = ''; };

  renderAccounts();
}

boot();
