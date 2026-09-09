/* Operator desk. One login, every brand, and the grant link that does the real work. */

const $ = (id) => document.getElementById(id);

const CADENCE_LABEL = {
  daily: 'every day', weekdays: 'weekdays', three: '3× a week', two: '2× a week', off: 'paused'
};

let desk = null;
let currentId = localStorage.getItem('cadent.brand') || null;

async function api(path, body) {
  const res = await fetch(path, body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : {});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

const el = (tag, props = {}, kids = []) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const kid of [].concat(kids)) node.append(kid);
  return node;
};

const current = () => desk.creators.find((c) => c.id === currentId) || desk.creators[0];

function renderNotice() {
  const waiting = Object.entries(desk.live).filter(([, v]) => !v.live);
  $('notice').hidden = waiting.length === 0;
  if (!waiting.length) return;
  const names = waiting.map(([id]) => desk.platforms.find((p) => p.id === id).name);
  $('notice').textContent =
    `Test connect is on for ${names.join(', ')}. Grant links save the creator's choice but cannot post yet. Set the app keys, then flip each *_LIVE=1 once review clears.`;
}

function renderBrands() {
  const host = $('brands');
  host.textContent = '';
  for (const c of desk.creators) {
    const btn = el('button', { className: 'brand-chip', type: 'button' }, [
      el('b', { textContent: c.name.split(' ')[0] }),
      el('span', { textContent: `${c.connected}/4 connected` })
    ]);
    btn.setAttribute('aria-pressed', String(c.id === current().id));
    btn.onclick = () => {
      currentId = c.id;
      localStorage.setItem('cadent.brand', c.id);
      render();
    };
    host.append(btn);
  }
}

function renderBrandPanel() {
  const c = current();
  const host = $('brandPanel');
  host.textContent = '';

  host.append(el('h2', { textContent: c.name }));
  host.append(el('p', {
    className: 'muted small',
    style: 'margin-top:6px',
    textContent: `@${c.handle} · ${c.timezone.replace('_', ' ')}`
  }));

  const pills = el('div', { className: 'pills' });
  for (const p of desk.platforms) {
    const acct = c.accounts[p.id];
    const on = acct.state === 'connected';
    const pill = el('span', {
      className: `pill${on ? ' on' : ''}`,
      textContent: on
        ? `${p.name}${acct.mode === 'test' ? ' (test)' : ''}`
        : `${p.name} · not connected`
    });
    pill.style.setProperty('--brand', p.color);
    pills.append(pill);
  }
  host.append(pills);

  const plan = c.plan;
  const routes = plan.routes.length
    ? plan.routes.map((r) => {
        const from = desk.platforms.find((p) => p.id === r.from).name;
        const to = desk.platforms.find((p) => p.id === r.to).name;
        return `${from} → ${to}`;
      }).join(', ')
    : 'no routes yet';
  host.append(el('p', {
    className: 'muted small',
    style: 'margin-top:16px',
    textContent: `Schedule: ${CADENCE_LABEL[plan.cadence]} at ${plan.time} · ${routes}`
  }));

  const toggle = el('button', {
    className: 'btn btn-quiet btn-sm',
    style: 'margin-top:16px',
    textContent: c.approvalRequired ? 'Approval required: on' : 'Approval required: off'
  });
  toggle.onclick = async () => {
    await api('/api/desk/creator', { creatorId: c.id, approvalRequired: !c.approvalRequired });
    await load();
  };
  host.append(toggle);
}

function render() {
  renderNotice();
  renderBrands();
  renderBrandPanel();
  const c = current();
  $('linkBox').value = c.link ? `${desk.origin}/g?t=${c.link}` : '';
  $('linkMsg').textContent = '';
}

async function load() {
  desk = await api('/api/desk');
  if (!desk.creators.some((c) => c.id === currentId)) currentId = desk.creators[0]?.id || null;
  render();
}

/* ---------- events ---------- */

$('loginForm').onsubmit = async (e) => {
  e.preventDefault();
  $('loginMsg').textContent = '';
  try {
    await api('/api/login', { password: $('password').value });
    $('password').value = '';
    await boot();
  } catch (err) {
    $('loginMsg').textContent = err.message;
  }
};

$('signOut').onclick = async () => {
  await api('/api/logout', {});
  location.reload();
};

$('mint').onclick = async () => {
  const c = current();
  const out = await api('/api/desk/link', { creatorId: c.id });
  $('linkBox').value = out.url;
  $('linkMsg').textContent = `New link for ${c.name}. The previous one no longer works.`;
  await load();
  $('linkBox').value = out.url;
};

$('copy').onclick = async () => {
  const value = $('linkBox').value;
  if (!value) { $('linkMsg').textContent = 'Mint a link first.'; return; }
  try {
    await navigator.clipboard.writeText(value);
    $('linkMsg').textContent = 'Copied.';
  } catch {
    // Clipboard needs a secure origin; over plain http the select-and-copy fallback works.
    $('linkBox').select();
    $('linkMsg').textContent = 'Selected — press ⌘C.';
  }
};

/* ---------- boot ---------- */

async function boot() {
  const session = await api('/api/session');
  document.title = session.brand;
  if (!session.signedIn) {
    $('login').hidden = false;
    $('desk').hidden = true;
    return;
  }
  $('login').hidden = true;
  $('desk').hidden = false;
  await load();
}

boot();
