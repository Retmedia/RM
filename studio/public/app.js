/* RET Studio front end. No build step, no framework — one state object, one
   render pass per view, same as the rest of this repo. */

const state = {
  view: 'today',
  creators: [],
  accounts: [],
  posts: [],
  media: [],
  platforms: [],
  allPlatforms: [],
  users: [],
  me: null,
  health: {},
  weekStart: startOfWeek(new Date()),
  filterCreator: null,
  draft: null,
  bulk: null,
  composeMode: 'single',
};

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');

/* ------------------------------------------------------------------ utils */

async function api(pathname, options = {}) {
  const res = await fetch(pathname, {
    headers: options.body && !options.raw ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
  });
  // A session that expired mid-use should land on the sign-in screen rather
  // than showing a wall of failed requests.
  if (res.status === 401) {
    location.replace('/login.html');
    throw new Error('Signed out');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `Request failed (${res.status})`), { body });
  return body;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function toast(message, bad) {
  const el = document.createElement('div');
  el.className = `toast${bad ? ' bad' : ''}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3600);
}

function startOfWeek(d) {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  copy.setDate(copy.getDate() - copy.getDay());
  return copy;
}

function addDays(d, n) {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + n);
  return copy;
}

const sameDay = (a, b) => a.toDateString() === b.toDateString();
const timeOf = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

const creatorById = (id) => state.creators.find((c) => c.id === id);
const accountById = (id) => state.accounts.find((a) => a.id === id);
const platformMeta = (id) => state.allPlatforms.find((p) => p.id === id)
  || state.platforms.find((p) => p.id === id)
  || { name: id, color: '#6b7280', enabled: false };

function avatar(creator, big) {
  const color = creator?.color || '#3a3f45';
  return `<span class="avatar${big ? ' lg' : ''}" style="background:${color}">${esc(initials(creator?.name))}</span>`;
}

/* ------------------------------------------------------------------- load */

async function refresh() {
  const [creators, accounts, posts, media, platforms, allPlatforms, users, health] = await Promise.all([
    api('/api/creators'), api('/api/accounts'), api('/api/posts'),
    api('/api/media'), api('/api/platforms'), api('/api/platforms/all'),
    api('/api/users'), api('/api/health'),
  ]);
  Object.assign(state, { creators, accounts, posts, media, platforms, allPlatforms, users, health });

  const today = new Date();
  const todayCount = posts.filter((p) => p.scheduledAt && sameDay(new Date(p.scheduledAt), today)).length;
  const weekEnd = addDays(state.weekStart, 7).toISOString();
  const weekCount = posts.filter((p) => p.scheduledAt
    && p.scheduledAt >= state.weekStart.toISOString() && p.scheduledAt < weekEnd).length;

  $('#count-today').textContent = todayCount || '';
  $('#count-week').textContent = weekCount || '';
  $('#count-creators').textContent = creators.length || '';
  $('#count-accounts').textContent = accounts.length || '';
  $('#count-team').textContent = users.filter((u) => !u.disabledAt).length || '';
  $('#mode-note').textContent = health.dryRun ? 'Dry run — nothing goes live' : 'Live publishing';
}

/* ------------------------------------------------------------------ views */

function render() {
  document.querySelectorAll('.nav-item').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === state.view);
  });
  ({
    today: renderToday,
    planner: renderPlanner,
    compose: renderCompose,
    creators: renderCreators,
    insights: renderInsights,
    connect: renderConnect,
    team: renderTeam,
  }[state.view] || renderToday)();
}

/* -- today -- */

function renderToday() {
  const now = new Date();
  const todays = state.posts
    .filter((p) => p.scheduledAt && sameDay(new Date(p.scheduledAt), now))
    .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  const upcoming = todays.filter((p) => p.status === 'scheduled');
  const sends = todays.reduce((n, p) => n + p.targets.length, 0);
  const failing = state.posts.filter((p) => p.status === 'failed' || p.status === 'partial');
  const stale = state.accounts.filter((a) => a.status === 'needs_reauth');
  const waiting = state.posts.filter((p) => p.approval?.required && p.approval.status === 'pending');
  const changes = state.posts.filter((p) => p.approval?.status === 'changes_requested');

  view.innerHTML = `
    <div class="eyebrow">${now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</div>
    <div class="hero-number">${sends}</div>
    <p class="hero-note">
      ${sends === 0 ? 'Nothing scheduled today.' : `posts going out today across <b>${new Set(todays.map((p) => p.creatorId)).size}</b> creators`}
    </p>

    ${stale.length ? `<div class="card" style="border-color:var(--warn);margin-bottom:18px">
      <div class="row between">
        <div><b>${stale.length} account${stale.length > 1 ? 's need' : ' needs'} reconnecting</b>
        <div class="meta" style="color:var(--muted);font-size:13px">${stale.map((a) => esc(a.displayName)).join(', ')}</div></div>
        <button class="btn ghost small" data-go="connect">Fix</button>
      </div></div>` : ''}

    ${changes.length ? `<div class="card" style="border-color:var(--warn);margin-bottom:18px">
      <b style="color:var(--warn)">${changes.length} post${changes.length > 1 ? 's' : ''} came back with changes</b>
      <ul class="tight">${changes.slice(0, 5).map((p) => `<li>${esc(creatorById(p.creatorId)?.name || '')} — ${esc(p.approval.note || 'no note left')}</li>`).join('')}</ul>
    </div>` : ''}

    ${waiting.length ? `<div class="card" style="margin-bottom:18px">
      <div class="row between">
        <div><b>${waiting.length} post${waiting.length > 1 ? 's' : ''} waiting on client approval</b>
        <div style="color:var(--muted);font-size:13px">They stay in the queue but will not publish until approved.</div></div>
      </div></div>` : ''}

    ${failing.length ? `<div class="card" style="border-color:var(--danger);margin-bottom:18px">
      <b style="color:var(--danger)">${failing.length} post${failing.length > 1 ? 's' : ''} did not go out</b>
      <ul class="tight">${failing.slice(0, 5).map((p) => `<li>${esc(creatorById(p.creatorId)?.name || 'Unknown')} — ${esc(p.targets.find((t) => t.error)?.error || 'failed')}</li>`).join('')}</ul>
    </div>` : ''}

    <h2>Queue</h2>
    <div class="card">
      ${todays.length ? todays.map(postRow).join('') : '<div class="empty">Nothing on the schedule today.</div>'}
    </div>

    <h2 style="margin-top:30px">Creators</h2>
    <div class="grid three">
      ${state.creators.map((c) => {
        const count = state.posts.filter((p) => p.creatorId === c.id && p.scheduledAt >= now.toISOString()).length;
        return `<div class="card" data-creator="${c.id}" style="cursor:pointer">
          <div class="row">${avatar(c, true)}
            <div><div style="font-weight:650">${esc(c.name)}</div>
            <div style="color:var(--muted);font-size:13px">${c.accounts.length} account${c.accounts.length === 1 ? '' : 's'}</div></div>
          </div>
          <div style="font-size:26px;font-weight:700;letter-spacing:-.03em;margin-top:14px">${count}</div>
          <div style="color:var(--faint);font-size:12px">upcoming</div>
        </div>`;
      }).join('') || '<div class="empty">No creators yet. Add one under Creators.</div>'}
    </div>`;

  view.querySelectorAll('[data-creator]').forEach((el) => {
    el.onclick = () => { state.filterCreator = el.dataset.creator; go('planner'); };
  });
  view.querySelectorAll('[data-go]').forEach((el) => { el.onclick = () => go(el.dataset.go); });
  bindPostRows();
}

function postRow(post) {
  const creator = creatorById(post.creatorId);
  const dots = post.targets.map((t) => {
    const account = accountById(t.accountId);
    const color = platformMeta(account?.platform).color;
    return `<span class="pill static" style="font-size:11px;padding:3px 9px">
      <span class="dot" style="background:${color}"></span>${esc(account?.displayName || 'removed')}</span>`;
  }).join(' ');
  return `<div class="list-row" data-post="${post.id}" style="cursor:pointer">
    ${avatar(creator)}
    <div style="flex:1;min-width:0">
      <div class="title">${esc(post.caption.split('\n')[0] || 'Untitled post')}</div>
      <div class="row wrap" style="gap:6px;margin-top:6px">${dots}</div>
    </div>
    <div style="text-align:right">
      <div style="font-variant-numeric:tabular-nums">${post.scheduledAt ? timeOf(post.scheduledAt) : '—'}</div>
      <span class="tag ${post.status}">${post.status}</span>
    </div>
  </div>`;
}

function bindPostRows() {
  view.querySelectorAll('[data-post]').forEach((el) => {
    el.onclick = () => openPost(el.dataset.post);
  });
}

/* -- planner -- */

function renderPlanner() {
  const days = Array.from({ length: 7 }, (_, i) => addDays(state.weekStart, i));
  const today = new Date();
  const creators = state.filterCreator
    ? state.creators.filter((c) => c.id === state.filterCreator)
    : state.creators;

  view.innerHTML = `
    <div class="row between" style="margin-bottom:6px">
      <div>
        <h1>Planner</h1>
        <p class="sub" style="margin:0">${state.weekStart.toLocaleDateString([], { month: 'long', day: 'numeric' })} – ${addDays(state.weekStart, 6).toLocaleDateString([], { month: 'long', day: 'numeric' })}</p>
      </div>
      <div class="row">
        <select id="creator-filter" style="width:190px">
          <option value="">All creators</option>
          ${state.creators.map((c) => `<option value="${c.id}" ${state.filterCreator === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select>
        <button class="btn ghost small" id="prev-week">←</button>
        <button class="btn ghost small" id="this-week">Today</button>
        <button class="btn ghost small" id="next-week">→</button>
      </div>
    </div>

    <div class="week" style="margin-top:22px">
      <div class="head"></div>
      ${days.map((d) => `<div class="head${sameDay(d, today) ? ' today' : ''}">
        ${d.toLocaleDateString([], { weekday: 'short' })}<br>
        <span style="font-size:15px;color:var(--text);font-weight:600">${d.getDate()}</span>
      </div>`).join('')}
      ${creators.map((c) => `
        <div class="lane-label">${avatar(c)} ${esc(c.name)}</div>
        ${days.map((d) => {
          const posts = state.posts.filter((p) => p.creatorId === c.id && p.scheduledAt && sameDay(new Date(p.scheduledAt), d));
          return `<div class="cell" data-day="${d.toISOString()}" data-lane="${c.id}">
            ${posts.map(plannerChip).join('')}
          </div>`;
        }).join('')}
      `).join('')}
    </div>
    ${creators.length ? '' : '<div class="empty">Add a creator to start planning.</div>'}
    <p class="note" style="margin-top:22px">Click any empty square to schedule into that day. Click a post to open it.</p>`;

  $('#prev-week').onclick = () => { state.weekStart = addDays(state.weekStart, -7); render(); };
  $('#next-week').onclick = () => { state.weekStart = addDays(state.weekStart, 7); render(); };
  $('#this-week').onclick = () => { state.weekStart = startOfWeek(new Date()); render(); };
  $('#creator-filter').onchange = (e) => { state.filterCreator = e.target.value || null; render(); };

  view.querySelectorAll('.cell').forEach((cell) => {
    cell.onclick = (e) => {
      const chip = e.target.closest('[data-post]');
      if (chip) return openPost(chip.dataset.post);
      const when = new Date(cell.dataset.day);
      when.setHours(9, 0, 0, 0);
      state.draft = { creatorId: cell.dataset.lane, scheduledAt: when };
      go('compose');
    };
  });
}

function plannerChip(post) {
  const border = post.status === 'published' ? 'var(--accent)'
    : post.status === 'failed' ? 'var(--danger)'
    : post.status === 'partial' ? 'var(--warn)' : 'var(--faint)';
  const icons = post.targets.map((t) => {
    const account = accountById(t.accountId);
    return `<i style="background:${platformMeta(account?.platform).color}"></i>`;
  }).join('');
  return `<div class="chip-post" data-post="${post.id}" style="border-left-color:${border}">
    <span class="when">${timeOf(post.scheduledAt)}</span> ${esc(post.caption.split('\n')[0].slice(0, 32) || 'Untitled')}
    <div class="icons">${icons}</div>
  </div>`;
}

/* -- compose -- */

function renderCompose() {
  if (state.composeMode === 'bulk') return renderBulk();
  return renderSingle();
}

function composeTabs() {
  return `<div class="row" style="gap:8px;margin-bottom:24px">
    <button class="pill${state.composeMode === 'single' ? ' on' : ''}" data-mode="single">One post</button>
    <button class="pill${state.composeMode === 'bulk' ? ' on' : ''}" data-mode="bulk">Bulk drop</button>
  </div>`;
}

function bindComposeTabs() {
  view.querySelectorAll('[data-mode]').forEach((el) => {
    el.onclick = () => { state.composeMode = el.dataset.mode; render(); };
  });
}

function renderSingle() {
  const draft = state.draft || {};
  const creatorId = draft.creatorId || state.creators[0]?.id || '';
  const creator = creatorById(creatorId);
  const when = draft.scheduledAt || nextSlot();
  const accounts = creator ? state.accounts.filter((a) => a.creatorId === creator.id) : [];

  view.innerHTML = `
    <h1>Compose</h1>
    <p class="sub">One caption, every account that creator posts to.</p>
    ${composeTabs()}

    ${state.creators.length ? '' : '<div class="card"><div class="empty">Add a creator first.</div></div>'}

    ${state.creators.length ? `
    <div class="grid two" style="align-items:start">
      <div class="card">
        <label class="field"><span>Creator</span>
          <select id="c-creator">${state.creators.map((c) => `<option value="${c.id}" ${c.id === creatorId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
        </label>

        <div class="eyebrow">Post to</div>
        <div class="row wrap" id="c-targets" style="margin-bottom:18px">
          ${accounts.length ? accounts.map((a) => `
            <button class="pill${a.status === 'connected' ? ' on' : ''}" data-account="${a.id}" ${a.status !== 'connected' ? 'disabled title="Reconnect this account first"' : ''}>
              <span class="dot" style="background:${platformMeta(a.platform).color}"></span>
              ${esc(a.displayName)}
            </button>`).join('')
            : `<div class="note warn">${esc(creator?.name || 'This creator')} has no connected accounts yet — connect them under Accounts.</div>`}
        </div>

        <label class="field"><span>Caption — the first line becomes the YouTube title</span>
          <textarea id="c-caption" placeholder="Write it once…">${esc(draft.caption || '')}</textarea>
        </label>
        <div class="row between" style="font-size:12px;color:var(--faint);margin-top:-10px;margin-bottom:16px">
          <span id="c-count">0 characters</span>
          <button class="btn quiet small" id="c-overrides">Per-platform captions</button>
        </div>

        <label class="field"><span>When</span>
          <input type="datetime-local" id="c-when" value="${localValue(when)}" />
        </label>

        <div class="row">
          <button class="btn" id="c-schedule">Schedule</button>
          <button class="btn ghost" id="c-now">Post now</button>
          <button class="btn quiet" id="c-draft">Save draft</button>
        </div>
        <div id="c-problems"></div>
      </div>

      <div class="card">
        <div class="eyebrow">Media</div>
        <input type="file" id="c-file" accept="video/mp4,video/quicktime,image/jpeg,image/png,image/webp" multiple style="margin-bottom:14px" />
        <div class="thumbs" id="c-media">
          ${state.media.map((m) => `<div class="thumb" data-media="${m.id}">
            ${m.kind === 'video' ? `<video src="${m.url}" muted></video>` : `<img src="${m.url}" alt="">`}
            <span class="kind">${m.kind === 'video' ? 'VID' : 'IMG'}</span>
          </div>`).join('') || '<div class="empty" style="padding:20px 0">No media uploaded.</div>'}
        </div>
      </div>
    </div>` : ''}`;

  bindComposeTabs();
  if (!state.creators.length) return;

  const selectedTargets = new Set(
    (draft.targets || accounts.filter((a) => a.status === 'connected').map((a) => a.id)),
  );
  const selectedMedia = new Set(draft.mediaIds || []);
  const overrides = draft.overrides || {};

  const paint = () => {
    view.querySelectorAll('[data-account]').forEach((el) => {
      el.classList.toggle('on', selectedTargets.has(el.dataset.account));
    });
    view.querySelectorAll('[data-media]').forEach((el) => {
      el.classList.toggle('on', selectedMedia.has(el.dataset.media));
    });
  };
  paint();

  view.querySelectorAll('[data-account]').forEach((el) => {
    el.onclick = () => {
      const id = el.dataset.account;
      selectedTargets.has(id) ? selectedTargets.delete(id) : selectedTargets.add(id);
      paint();
    };
  });
  view.querySelectorAll('[data-media]').forEach((el) => {
    el.onclick = () => {
      const id = el.dataset.media;
      selectedMedia.has(id) ? selectedMedia.delete(id) : selectedMedia.add(id);
      paint();
    };
  });

  const caption = $('#c-caption');
  const countEl = $('#c-count');
  const updateCount = () => {
    const n = caption.value.length;
    const tightest = Math.min(...[...selectedTargets]
      .map((id) => platformMeta(accountById(id)?.platform).limits?.captionChars || 99999));
    countEl.textContent = `${n} characters${Number.isFinite(tightest) && tightest < 99999 ? ` · limit ${tightest}` : ''}`;
    countEl.style.color = n > tightest ? 'var(--danger)' : 'var(--faint)';
  };
  caption.oninput = updateCount;
  updateCount();

  $('#c-creator').onchange = (e) => {
    state.draft = { creatorId: e.target.value, scheduledAt: new Date($('#c-when').value), caption: caption.value };
    render();
  };

  $('#c-overrides').onclick = () => openOverrides([...selectedTargets], overrides, caption.value);

  $('#c-file').onchange = async (e) => {
    for (const file of e.target.files) {
      try {
        const saved = await api('/api/media', {
          method: 'POST',
          raw: true,
          headers: { 'Content-Type': file.type, 'x-filename': file.name },
          body: file,
        });
        selectedMedia.add(saved.id);
        toast(`Uploaded ${file.name}`);
      } catch (err) { toast(err.message, true); }
    }
    state.draft = {
      creatorId: $('#c-creator').value,
      caption: caption.value,
      scheduledAt: new Date($('#c-when').value),
      targets: [...selectedTargets],
      mediaIds: [...selectedMedia],
      overrides,
    };
    await refresh();
    render();
  };

  const collect = (status) => ({
    creatorId: $('#c-creator').value,
    caption: caption.value,
    mediaIds: [...selectedMedia],
    scheduledAt: new Date($('#c-when').value).toISOString(),
    status,
    targets: [...selectedTargets].map((id) => ({ accountId: id, captionOverride: overrides[id] || null, options: {} })),
  });

  const save = async (status, publishNow) => {
    if (!selectedTargets.size) return toast('Pick at least one account.', true);
    try {
      const post = await api('/api/posts', { method: 'POST', body: JSON.stringify(collect(status)) });
      const { problems } = await api(`/api/posts/${post.id}/validate`, { method: 'POST' });
      if (problems.length) {
        $('#c-problems').innerHTML = problems.map((p) => `<div class="note warn">
          <b>${esc(p.accountName || p.accountId)}</b><ul class="tight">${p.messages.map((m) => `<li>${esc(m)}</li>`).join('')}</ul></div>`).join('');
        if (publishNow) return;
      }
      if (publishNow) await api(`/api/posts/${post.id}/publish`, { method: 'POST', body: JSON.stringify({}) });
      state.draft = null;
      await refresh();
      toast(publishNow ? 'Sent.' : status === 'draft' ? 'Draft saved.' : 'Scheduled.');
      go(publishNow ? 'today' : 'planner');
    } catch (err) { toast(err.message, true); }
  };

  $('#c-schedule').onclick = () => save('scheduled', false);
  $('#c-now').onclick = () => save('scheduled', true);
  $('#c-draft').onclick = () => save('draft', false);
}

function openOverrides(targetIds, overrides, base) {
  if (!targetIds.length) return toast('Pick accounts first.', true);
  modal(`
    <h2>Per-platform captions</h2>
    <p class="sub" style="margin-bottom:18px">Leave a box empty to use the main caption.</p>
    ${targetIds.map((id) => {
      const account = accountById(id);
      return `<label class="field"><span>
        <span class="dot" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${platformMeta(account.platform).color}"></span>
        ${esc(account.displayName)} · ${esc(platformMeta(account.platform).name)}</span>
        <textarea data-override="${id}" placeholder="${esc(base.slice(0, 90))}">${esc(overrides[id] || '')}</textarea></label>`;
    }).join('')}
    <button class="btn" id="ov-save">Done</button>`, (root) => {
    $('#ov-save', root).onclick = () => {
      root.querySelectorAll('[data-override]').forEach((el) => {
        const value = el.value.trim();
        if (value) overrides[el.dataset.override] = value;
        else delete overrides[el.dataset.override];
      });
      closeModal();
    };
  });
}

function nextSlot() {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 2);
  return d;
}

function localValue(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* -- creators -- */

/* -- bulk drop -- */

function renderBulk() {
  const draft = state.bulk || {};
  const creatorId = draft.creatorId || state.creators[0]?.id || '';
  const creator = creatorById(creatorId);
  const accounts = creator ? state.accounts.filter((a) => a.creatorId === creator.id && a.status === 'connected') : [];
  const picked = draft.mediaIds || [];

  view.innerHTML = `
    <h1>Compose</h1>
    <p class="sub">Drop a month of clips in one go. They land in this creator's open slots, in order.</p>
    ${composeTabs()}

    ${state.creators.length ? `
    <div class="grid two" style="align-items:start">
      <div class="card">
        <label class="field"><span>Creator</span>
          <select id="b-creator">${state.creators.map((c) => `<option value="${c.id}" ${c.id === creatorId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
        </label>

        <div class="eyebrow">Posting rhythm</div>
        <div class="row between" style="margin-bottom:18px">
          <span style="font-size:14px" id="b-rhythm">…</span>
          <button class="btn quiet small" data-go="creators">Change</button>
        </div>

        <div class="eyebrow">Every post goes to</div>
        <div class="row wrap" style="margin-bottom:20px">
          ${accounts.length ? accounts.map((a) => `<span class="pill static">
            <span class="dot" style="background:${platformMeta(a.platform).color}"></span>${esc(a.displayName)}</span>`).join('')
            : '<div class="note warn">No connected accounts for this creator.</div>'}
        </div>

        <label class="field"><span>Add the clips — order is the order they post in</span>
          <input type="file" id="b-file" accept="video/mp4,video/quicktime,image/jpeg,image/png,image/webp" multiple />
        </label>

        <div id="b-progress" style="font-size:13px;color:var(--muted)"></div>

        <div class="row" style="margin-top:18px">
          <button class="btn" id="b-schedule" ${picked.length && accounts.length ? '' : 'disabled'}>
            Schedule ${picked.length || ''} post${picked.length === 1 ? '' : 's'}
          </button>
          <button class="btn quiet" id="b-clear" ${picked.length ? '' : 'disabled'}>Clear</button>
        </div>
      </div>

      <div class="card">
        <div class="eyebrow">Where they land</div>
        <div id="b-plan">
          ${picked.length ? '<div class="empty" style="padding:20px 0">Working out the slots…</div>'
            : '<div class="empty" style="padding:30px 0">Add clips to see the schedule.</div>'}
        </div>
      </div>
    </div>` : '<div class="card"><div class="empty">Add a creator first.</div></div>'}`;

  bindComposeTabs();
  view.querySelectorAll('[data-go]').forEach((el) => { el.onclick = () => go(el.dataset.go); });
  if (!state.creators.length) return;

  loadRhythm(creatorId, picked.length);

  $('#b-creator').onchange = (e) => {
    state.bulk = { creatorId: e.target.value, mediaIds: [] };
    render();
  };

  $('#b-clear').onclick = () => { state.bulk = { creatorId }; render(); };

  $('#b-file').onchange = async (e) => {
    const files = [...e.target.files];
    const ids = [];
    const progress = $('#b-progress');
    for (let i = 0; i < files.length; i += 1) {
      progress.textContent = `Uploading ${i + 1} of ${files.length} — ${files[i].name}`;
      try {
        const saved = await api('/api/media', {
          method: 'POST',
          raw: true,
          headers: { 'Content-Type': files[i].type, 'x-filename': files[i].name },
          body: files[i],
        });
        ids.push(saved.id);
      } catch (err) {
        progress.textContent = '';
        toast(`${files[i].name}: ${err.message}`, true);
      }
    }
    state.bulk = { creatorId: $('#b-creator').value, mediaIds: [...picked, ...ids] };
    await refresh();
    render();
  };

  $('#b-schedule').onclick = async () => {
    try {
      const result = await api('/api/posts/bulk', {
        method: 'POST',
        body: JSON.stringify({ creatorId: $('#b-creator').value, mediaIds: picked }),
      });
      state.bulk = null;
      state.composeMode = 'single';
      await refresh();
      toast(`Scheduled ${result.created} posts.`);
      go('planner');
    } catch (err) { toast(err.message, true); }
  };
}

// The plan preview comes from the server so it uses the same slot maths the
// bulk endpoint will use — no chance of the preview disagreeing with reality.
async function loadRhythm(creatorId, count) {
  try {
    const { rhythm, slots } = await api(`/api/creators/${creatorId}/slots/preview?count=${Math.max(count, 5)}`);
    const rhythmEl = $('#b-rhythm');
    if (rhythmEl) rhythmEl.textContent = rhythm;
    const plan = $('#b-plan');
    if (!plan || !count) return;
    const media = state.media.filter((m) => (state.bulk?.mediaIds || []).includes(m.id));
    plan.innerHTML = slots.slice(0, count).map((iso, i) => `<div class="list-row" style="padding:10px 4px">
      <span style="color:var(--faint);font-size:12px;width:22px;font-variant-numeric:tabular-nums">${i + 1}</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(media[i]?.filename || 'clip')}</div>
      </div>
      <div style="font-size:12px;color:var(--muted);text-align:right;font-variant-numeric:tabular-nums">
        ${new Date(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}<br>${timeOf(iso)}
      </div>
    </div>`).join('');
  } catch (err) {
    const plan = $('#b-plan');
    if (plan) plan.innerHTML = `<div class="note warn">${esc(err.message)}</div>`;
  }
}

function renderCreators() {
  view.innerHTML = `
    <div class="row between">
      <div><h1>Creators</h1><p class="sub" style="margin:0">Each creator owns their own accounts. Nothing is shared between them.</p></div>
      <button class="btn" id="add-creator">Add creator</button>
    </div>
    <div class="grid two" style="margin-top:26px">
      ${state.creators.map((c) => `<div class="card">
        <div class="row between">
          <div class="row">${avatar(c, true)}
            <div><div style="font-weight:650;font-size:16px">${esc(c.name)}</div>
            <div style="color:var(--muted);font-size:13px">${c.handle ? '@' + esc(c.handle) : 'no handle set'}</div></div>
          </div>
          <div class="row" style="gap:2px">
            <button class="btn quiet small" data-edit="${c.id}">Edit</button>
            <button class="btn quiet small" data-remove="${c.id}">Remove</button>
          </div>
        </div>
        <div class="row wrap" style="gap:8px;margin-top:14px">
          <span class="tag">${esc(describeSlots(c.slots))}</span>
          ${c.requiresApproval ? '<span class="tag" style="color:var(--warn);border-color:var(--warn)">Client approves</span>' : ''}
        </div>
        <div style="margin-top:16px">
          ${c.accounts.length ? c.accounts.map((a) => `<div class="row" style="padding:7px 0;font-size:13px">
            <span class="dot" style="width:8px;height:8px;border-radius:50%;background:${platformMeta(a.platform).color}"></span>
            <span>${esc(a.displayName)}</span>
            <span class="spacer"></span>
            <span class="tag ${a.status === 'connected' ? 'published' : 'failed'}">${a.status === 'connected' ? 'live' : 'reconnect'}</span>
          </div>`).join('') : '<div style="color:var(--faint);font-size:13px">No accounts connected.</div>'}
        </div>
      </div>`).join('') || '<div class="empty">No creators yet.</div>'}
    </div>`;

  $('#add-creator').onclick = () => modal(`
    <h2>Add creator</h2>
    <label class="field"><span>Name</span><input type="text" id="n-name" placeholder="Blair Conklin" /></label>
    <label class="field"><span>Handle</span><input type="text" id="n-handle" placeholder="blairconklin" /></label>
    <button class="btn" id="n-save">Add</button>`, (root) => {
    $('#n-save', root).onclick = async () => {
      const name = $('#n-name', root).value.trim();
      if (!name) return toast('Name is required.', true);
      await api('/api/creators', {
        method: 'POST',
        body: JSON.stringify({ name, handle: $('#n-handle', root).value.trim() }),
      });
      closeModal();
      await refresh();
      render();
    };
  });

  view.querySelectorAll('[data-edit]').forEach((el) => {
    el.onclick = () => openCreatorSettings(creatorById(el.dataset.edit));
  });

  view.querySelectorAll('[data-remove]').forEach((el) => {
    el.onclick = async () => {
      const creator = creatorById(el.dataset.remove);
      if (!confirm(`Remove ${creator.name}? Their connected accounts and scheduled posts go too.`)) return;
      await api(`/api/creators/${el.dataset.remove}`, { method: 'DELETE' });
      await refresh();
      render();
    };
  });
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function describeSlots(slots) {
  if (!slots?.length) return 'No rhythm set';
  const days = [...new Set(slots.map((s) => s.day))].sort().map((d) => DAY_NAMES[d]);
  return `${slots.length}/week · ${days.join(' ')}`;
}

function openCreatorSettings(creator) {
  if (!creator) return;
  let slots = (creator.slots || []).map((s) => ({ ...s }));

  const drawSlots = (root) => {
    const list = $('#cs-slots', root);
    list.innerHTML = slots.length
      ? slots.map((s, i) => `<div class="row" style="padding:7px 0;border-bottom:1px solid var(--line-soft)">
          <span style="width:52px;font-size:13px;font-weight:600">${DAY_NAMES[s.day]}</span>
          <span style="font-variant-numeric:tabular-nums;font-size:14px">${s.time}</span>
          <span class="spacer"></span>
          <button class="btn quiet small" data-drop="${i}">Remove</button>
        </div>`).join('')
      : '<div style="color:var(--faint);font-size:13px;padding:8px 0">No slots — bulk drops need at least one.</div>';
    list.querySelectorAll('[data-drop]').forEach((el) => {
      el.onclick = () => { slots.splice(Number(el.dataset.drop), 1); drawSlots(root); };
    });
    $('#cs-summary', root).textContent = describeSlots(slots);
  };

  modal(`
    <h2>${esc(creator.name)}</h2>
    <p class="sub" style="margin-bottom:22px">The rhythm a bulk drop fills, and whether this client signs off before anything publishes.</p>

    <div class="eyebrow">Posting rhythm — <span id="cs-summary"></span></div>
    <div id="cs-slots" style="margin-bottom:14px"></div>

    <div class="row" style="gap:8px;margin-bottom:24px">
      <select id="cs-day" style="width:120px">
        ${DAY_NAMES.map((d, i) => `<option value="${i}">${d}</option>`).join('')}
      </select>
      <input type="text" id="cs-time" placeholder="09:00" style="width:110px" />
      <button class="btn ghost small" id="cs-add">Add slot</button>
    </div>

    <label class="row" style="gap:10px;margin-bottom:26px;cursor:pointer">
      <input type="checkbox" id="cs-approval" ${creator.requiresApproval ? 'checked' : ''} style="width:auto" />
      <span style="font-size:14px">Send every post to this client for approval before it publishes</span>
    </label>

    <button class="btn" id="cs-save">Save</button>`, (root) => {
    drawSlots(root);

    $('#cs-add', root).onclick = () => {
      const time = $('#cs-time', root).value.trim();
      if (!/^\d{1,2}:\d{2}$/.test(time)) return toast('Time looks like 09:00 or 17:30.', true);
      const [h, m] = time.split(':');
      const padded = `${String(Number(h)).padStart(2, '0')}:${m}`;
      if (Number(h) > 23 || Number(m) > 59) return toast('That is not a real time.', true);
      slots.push({ day: Number($('#cs-day', root).value), time: padded });
      slots.sort((a, b) => a.day - b.day || a.time.localeCompare(b.time));
      $('#cs-time', root).value = '';
      drawSlots(root);
    };

    $('#cs-save', root).onclick = async () => {
      await api(`/api/creators/${creator.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ slots, requiresApproval: $('#cs-approval', root).checked }),
      });
      closeModal();
      await refresh();
      render();
      toast('Saved.');
    };
  });
}

/* -- connect -- */

function renderConnect() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  if (params.get('error')) toast(params.get('error'), true);
  if (params.get('connected')) toast(`Connected ${params.get('connected')} account(s).`);

  view.innerHTML = `
    <div class="row between">
      <div>
        <h1>Accounts</h1>
        <p class="sub" style="margin:0">Send the creator a link and they connect themselves. Nobody's role has to change.</p>
      </div>
      <button class="btn" id="new-invite">Send an invite</button>
    </div>

    <div class="card" style="margin:26px 0 20px;border-color:var(--accent)">
      <div class="eyebrow">The short version</div>
      <p style="margin:0;color:var(--muted);line-height:1.6">
        YouTube only accepts a token held by a channel <b style="color:var(--text)">Owner</b> — being a Manager
        gets you nothing through the API. That does not mean a client has to promote you.
        They already are the owner. Send them an invite, they tap Allow with their own login,
        and this can post. Their role never changes and they can revoke it themselves.
      </p>
    </div>

    <div class="grid two">
      ${state.platforms.map((p) => {
        const mine = state.accounts.filter((a) => a.platform === p.id);
        const badge = { bulk: 'All at once', picker: 'Channel picker', 'per-account': 'One at a time' }[p.multiAccount];
        return `<div class="card">
          <div class="row between">
            <div class="row"><span class="dot" style="width:10px;height:10px;border-radius:50%;background:${p.color}"></span>
              <b style="font-size:16px">${esc(p.name)}</b></div>
            <span class="tag">${badge}</span>
          </div>
          <p class="note">${esc(p.multiAccountNote)}</p>
          <ul class="tight">${p.requirements.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
          <div class="row wrap" style="margin-top:16px;gap:8px">
            <button class="btn ghost small" data-connect="${p.id}">Connect with my login</button>
            <button class="btn quiet small" data-demo="${p.id}">Add test account</button>
          </div>
          ${mine.length ? `<div style="margin-top:16px;border-top:1px solid var(--line-soft);padding-top:12px">
            ${mine.map((a) => `<div class="row" style="padding:6px 0;font-size:13px">
              <span>${esc(a.displayName)}</span>
              ${a.connectedVia === 'invite' ? '<span class="tag" style="color:var(--accent);border-color:var(--accent)">creator</span>' : ''}
              <span class="spacer"></span>
              <select data-assign="${a.id}" style="width:150px;padding:5px 8px;font-size:12px">
                <option value="">Unassigned</option>
                ${state.creators.map((c) => `<option value="${c.id}" ${c.id === a.creatorId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
              </select>
              <button class="btn quiet small" data-disconnect="${a.id}">×</button>
            </div>`).join('')}
          </div>` : ''}
        </div>`;
      }).join('')}
    </div>

    <div class="card" style="margin-top:20px">
      <div class="eyebrow">One thing worth knowing</div>
      <p style="margin:0 0 12px;color:var(--muted);line-height:1.6">
        No API can read the accounts you have switched between inside the TikTok or X app on your phone —
        that list never leaves the device. Instagram is the one exception: a single Meta login pulls in every
        Instagram account attached to a Page you manage.
      </p>
      <p style="margin:0;color:var(--muted);line-height:1.6">
        X is the only platform here with a paid API tier. Price that in before you quote a client.
      </p>
    </div>`;

  $('#new-invite').onclick = () => openInviteBuilder();

  view.querySelectorAll('[data-connect]').forEach((el) => {
    el.onclick = async () => {
      try {
        const { url } = await api(`/api/connect/${el.dataset.connect}`, { method: 'POST', body: JSON.stringify({}) });
        location.href = url;
      } catch (err) { toast(err.message, true); }
    };
  });

  renderInviteList();

  view.querySelectorAll('[data-demo]').forEach((el) => {
    el.onclick = () => modal(`
      <h2>Add a test account</h2>
      <p class="sub">Stands in for a real connection so the planner can be tried before the developer apps are approved.</p>
      <label class="field"><span>Username</span><input type="text" id="d-user" placeholder="blairconklin" /></label>
      <label class="field"><span>Creator</span><select id="d-creator">
        ${state.creators.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}
      </select></label>
      <button class="btn" id="d-save">Add</button>`, (root) => {
      $('#d-save', root).onclick = async () => {
        const username = $('#d-user', root).value.trim();
        if (!username) return toast('Username is required.', true);
        await api('/api/accounts/demo', {
          method: 'POST',
          body: JSON.stringify({
            platform: el.dataset.demo,
            username,
            displayName: username,
            creatorId: $('#d-creator', root).value || null,
          }),
        });
        closeModal();
        await refresh();
        render();
      };
    });
  });

  view.querySelectorAll('[data-assign]').forEach((el) => {
    el.onchange = async () => {
      await api(`/api/accounts/${el.dataset.assign}`, {
        method: 'PATCH',
        body: JSON.stringify({ creatorId: el.value || null }),
      });
      await refresh();
    };
  });

  view.querySelectorAll('[data-disconnect]').forEach((el) => {
    el.onclick = async () => {
      if (!confirm('Disconnect this account?')) return;
      await api(`/api/accounts/${el.dataset.disconnect}`, { method: 'DELETE' });
      await refresh();
      render();
    };
  });
}

/* -- post detail -- */

async function openPost(id) {
  const post = state.posts.find((p) => p.id === id);
  if (!post) return;
  const creator = creatorById(post.creatorId);
  const media = state.media.filter((m) => post.mediaIds.includes(m.id));

  modal(`
    <div class="row between" style="margin-bottom:18px">
      <div class="row">${avatar(creator, true)}
        <div><b>${esc(creator?.name || 'Unknown creator')}</b>
        <div style="color:var(--muted);font-size:13px">${post.scheduledAt ? new Date(post.scheduledAt).toLocaleString() : 'Not scheduled'}</div></div>
      </div>
      <span class="tag ${post.status}">${post.status}</span>
    </div>

    ${media.length ? `<div class="thumbs" style="margin-bottom:18px">${media.map((m) => `<div class="thumb">
      ${m.kind === 'video' ? `<video src="${m.url}" muted></video>` : `<img src="${m.url}" alt="">`}</div>`).join('')}</div>` : ''}

    <div class="card" style="background:var(--surface-2);white-space:pre-wrap;margin-bottom:18px">${esc(post.caption) || '<span style="color:var(--faint)">No caption</span>'}</div>

    ${approvalPanel(post)}

    <div class="eyebrow">Destinations</div>
    ${post.targets.map((t) => {
      const account = accountById(t.accountId);
      return `<div class="list-row">
        <span class="dot" style="width:8px;height:8px;border-radius:50%;background:${platformMeta(account?.platform).color}"></span>
        <div style="flex:1">
          <div class="title" style="font-size:14px">${esc(account?.displayName || 'Removed account')}</div>
          ${t.error ? `<div class="meta" style="color:var(--danger)">${esc(t.error)}</div>` : ''}
          ${t.remoteUrl ? `<a class="meta" href="${t.remoteUrl}" target="_blank" rel="noreferrer">View post ↗</a>` : ''}
        </div>
        <span class="tag ${t.status === 'published' ? 'published' : t.status === 'failed' ? 'failed' : ''}">${t.status}</span>
      </div>`;
    }).join('')}

    <div class="row wrap" style="margin-top:22px;gap:8px">
      <button class="btn small" id="p-publish">${post.status === 'published' ? 'Publish again' : 'Publish now'}</button>
      <button class="btn ghost small" id="p-review">${post.approval?.required ? 'New review link' : 'Send for approval'}</button>
      <button class="btn ghost small" id="p-close">Close</button>
      <span class="spacer"></span>
      <button class="btn danger small" id="p-delete">Delete</button>
    </div>`, (root) => {
    $('#p-close', root).onclick = closeModal;
    $('#p-review', root).onclick = async () => {
      const { link } = await api(`/api/posts/${post.id}/review`, {
        method: 'POST',
        body: JSON.stringify({ required: true }),
      });
      await refresh();
      closeModal();
      render();
      showReviewLink(link);
    };
    const copy = $('#p-copy', root);
    if (copy) copy.onclick = () => copyText(copy.dataset.link);
    $('#p-publish', root).onclick = async () => {
      try {
        await api(`/api/posts/${post.id}/publish`, { method: 'POST', body: JSON.stringify({ force: true }) });
        closeModal();
        await refresh();
        render();
        toast('Publish run finished.');
      } catch (err) { toast(err.body?.problems ? 'Fix the validation problems first.' : err.message, true); }
    };
    $('#p-delete', root).onclick = async () => {
      if (!confirm('Delete this post?')) return;
      await api(`/api/posts/${post.id}`, { method: 'DELETE' });
      closeModal();
      await refresh();
      render();
    };
  });
}

async function renderInviteList() {
  let invites = [];
  try { invites = await api('/api/invites'); } catch { return; }
  const host = document.createElement('div');
  host.style.marginTop = '20px';
  host.innerHTML = `
    <h2>Open invites</h2>
    <div class="card">
      ${invites.length ? invites.map((i) => {
        const creator = creatorById(i.creatorId);
        const done = i.connected.length;
        return `<div class="list-row">
          ${avatar(creator)}
          <div style="flex:1;min-width:0">
            <div class="title">${esc(creator?.name || 'Unknown creator')}</div>
            <div class="meta">${done ? `${done} of ${i.platforms.length} connected` : `waiting on ${i.platforms.length} account${i.platforms.length === 1 ? '' : 's'}`}
              · expires ${new Date(i.expiresAt).toLocaleDateString()}</div>
          </div>
          <button class="btn ghost small" data-copy-invite="${esc(i.link)}">Copy link</button>
          <button class="btn quiet small" data-kill-invite="${i.id}">Revoke</button>
        </div>`;
      }).join('') : '<div class="empty">No invites out right now.</div>'}
    </div>`;
  view.appendChild(host);

  host.querySelectorAll('[data-copy-invite]').forEach((el) => {
    el.onclick = () => copyText(el.dataset.copyInvite);
  });
  host.querySelectorAll('[data-kill-invite]').forEach((el) => {
    el.onclick = async () => {
      if (!confirm('Revoke this link? Anyone holding it can no longer connect.')) return;
      await api(`/api/invites/${el.dataset.killInvite}`, { method: 'DELETE' });
      render();
    };
  });
}

function openInviteBuilder() {
  if (!state.creators.length) return toast('Add a creator first.', true);
  const chosen = new Set(state.platforms.map((p) => p.id));

  modal(`
    <h2>Send an invite</h2>
    <p class="sub" style="margin-bottom:20px">
      The creator opens this and authorises with their own login. For YouTube that is what makes it
      work at all — they are already the Owner, so nothing about their role has to change.
    </p>

    <label class="field"><span>Creator</span>
      <select id="iv-creator">${state.creators.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>
    </label>

    <div class="eyebrow">Ask them to connect</div>
    <div class="row wrap" id="iv-platforms" style="margin-bottom:20px">
      ${state.platforms.map((p) => `<button class="pill on" data-pick="${p.id}">
        <span class="dot" style="background:${p.color}"></span>${esc(p.name)}</button>`).join('')}
    </div>

    <label class="field"><span>A line for them (optional)</span>
      <input type="text" id="iv-note" placeholder="Quick one so we can start posting the clips" />
    </label>

    <button class="btn" id="iv-make">Create link</button>`, (root) => {
    root.querySelectorAll('[data-pick]').forEach((el) => {
      el.onclick = () => {
        const id = el.dataset.pick;
        chosen.has(id) ? chosen.delete(id) : chosen.add(id);
        el.classList.toggle('on', chosen.has(id));
      };
    });

    $('#iv-make', root).onclick = async () => {
      if (!chosen.size) return toast('Pick at least one platform.', true);
      try {
        const { link } = await api('/api/invites', {
          method: 'POST',
          body: JSON.stringify({
            creatorId: $('#iv-creator', root).value,
            platforms: [...chosen],
            note: $('#iv-note', root).value.trim(),
          }),
        });
        closeModal();
        await refresh();
        render();
        showInviteLink(link);
      } catch (err) { toast(err.message, true); }
    };
  });
}

function showInviteLink(link) {
  modal(`
    <h2>Send them this</h2>
    <p class="sub">One tap per account. They keep ownership of everything, and can revoke it themselves at any time.</p>
    <div class="card" style="background:var(--surface-2);word-break:break-all;font-size:13px">${esc(link)}</div>
    <div class="row" style="margin-top:18px;gap:8px">
      <button class="btn" id="il-copy">Copy link</button>
      <button class="btn ghost" id="il-close">Done</button>
    </div>`, (root) => {
    $('#il-copy', root).onclick = () => copyText(link);
    $('#il-close', root).onclick = closeModal;
  });
}

/* -- team -- */

function renderTeam() {
  const isOwner = state.me?.role === 'owner';

  view.innerHTML = `
    <div class="row between">
      <div>
        <h1>Team</h1>
        <p class="sub" style="margin:0">Everyone works from their own account. Nobody shares a login.</p>
      </div>
      ${isOwner ? '<button class="btn" id="add-user">Add someone</button>' : ''}
    </div>

    <div class="card" style="margin-top:26px">
      ${state.users.map((u) => `<div class="list-row">
        <span class="avatar" style="background:${u.role === 'owner' ? 'var(--accent)' : '#5b8cff'}">${esc(initials(u.name))}</span>
        <div style="flex:1;min-width:0">
          <div class="title">${esc(u.name)}${u.id === state.me?.id ? ' <span style="color:var(--faint);font-weight:400">— you</span>' : ''}</div>
          <div class="meta">${esc(u.email)}</div>
        </div>
        <span class="tag${u.role === 'owner' ? ' published' : ''}">${u.role}</span>
        ${u.disabledAt ? '<span class="tag failed">off</span>' : ''}
        ${isOwner && u.id !== state.me?.id ? `
          <button class="btn quiet small" data-toggle-user="${u.id}" data-on="${u.disabledAt ? '1' : '0'}">
            ${u.disabledAt ? 'Restore' : 'Switch off'}</button>
          <button class="btn quiet small" data-drop-user="${u.id}">Remove</button>` : ''}
        ${u.id === state.me?.id ? '<button class="btn ghost small" id="change-pw">Password</button>' : ''}
      </div>`).join('')}
    </div>

    ${isOwner ? '' : '<p class="note" style="margin-top:18px">Only an owner can add or remove people.</p>'}`;

  if (isOwner) {
    $('#add-user').onclick = () => modal(`
      <h2>Add someone</h2>
      <p class="sub" style="margin-bottom:20px">They sign in with their own email and password. A manager runs the day to day; an owner can also change the team.</p>
      <label class="field"><span>Name</span><input type="text" id="u-name" placeholder="Olivia" /></label>
      <label class="field"><span>Email</span><input type="email" id="u-email" /></label>
      <label class="field"><span>Role</span><select id="u-role">
        <option value="manager">Manager</option><option value="owner">Owner</option>
      </select></label>
      <label class="field"><span>Starting password — at least 10 characters, with a number</span>
        <input type="text" id="u-pass" /></label>
      <button class="btn" id="u-save">Add</button>`, (root) => {
      $('#u-save', root).onclick = async () => {
        try {
          await api('/api/users', {
            method: 'POST',
            body: JSON.stringify({
              name: $('#u-name', root).value.trim(),
              email: $('#u-email', root).value.trim(),
              role: $('#u-role', root).value,
              password: $('#u-pass', root).value,
            }),
          });
          closeModal();
          await refresh();
          render();
          toast('Added. Send them the password — they can change it once they are in.');
        } catch (err) { toast(err.message, true); }
      };
    });

    view.querySelectorAll('[data-toggle-user]').forEach((el) => {
      el.onclick = async () => {
        await api(`/api/users/${el.dataset.toggleUser}`, {
          method: 'PATCH',
          body: JSON.stringify({ disabled: el.dataset.on !== '1' }),
        });
        await refresh();
        render();
      };
    });

    view.querySelectorAll('[data-drop-user]').forEach((el) => {
      el.onclick = async () => {
        if (!confirm('Remove this person? They are signed out immediately.')) return;
        try {
          await api(`/api/users/${el.dataset.dropUser}`, { method: 'DELETE' });
          await refresh();
          render();
        } catch (err) { toast(err.message, true); }
      };
    });
  }

  const pw = $('#change-pw');
  if (pw) pw.onclick = () => modal(`
    <h2>Change your password</h2>
    <label class="field"><span>New password — at least 10 characters, with a number</span>
      <input type="password" id="p-new" /></label>
    <button class="btn" id="p-save">Save</button>`, (root) => {
    $('#p-save', root).onclick = async () => {
      try {
        await api(`/api/users/${state.me.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ password: $('#p-new', root).value }),
        });
        closeModal();
        toast('Password changed.');
      } catch (err) { toast(err.message, true); }
    };
  });
}

function approvalPanel(post) {
  const a = post.approval;
  if (!a?.required) return '';
  const link = `${location.origin}/review/${a.token}`;
  const label = {
    pending: 'Waiting on the client',
    approved: 'Approved by the client',
    changes_requested: 'Client asked for changes',
  }[a.status] || a.status;
  const color = a.status === 'approved' ? 'var(--accent)' : a.status === 'changes_requested' ? 'var(--danger)' : 'var(--warn)';
  return `<div class="card" style="background:var(--surface-2);margin-bottom:18px">
    <div class="row between">
      <b style="color:${color}">${label}</b>
      ${a.reviewedAt ? `<span style="font-size:12px;color:var(--faint)">${new Date(a.reviewedAt).toLocaleString()}</span>` : ''}
    </div>
    ${a.note ? `<div style="margin-top:8px;color:var(--muted);font-size:14px">"${esc(a.note)}"</div>` : ''}
    ${a.status === 'pending' ? `<div class="row" style="margin-top:12px;gap:8px">
      <code style="flex:1;min-width:0;font-size:11px;color:var(--faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(link)}</code>
      <button class="btn ghost small" id="p-copy" data-link="${esc(link)}">Copy link</button>
    </div>` : ''}
  </div>`;
}

function copyText(text) {
  navigator.clipboard?.writeText(text)
    .then(() => toast('Link copied.'))
    .catch(() => toast(text, false));
}

function showReviewLink(link) {
  if (!link) return;
  modal(`
    <h2>Send this to the client</h2>
    <p class="sub">It opens one post, needs no login, and stops working the moment you re-open review after an edit.</p>
    <div class="card" style="background:var(--surface-2);word-break:break-all;font-size:13px">${esc(link)}</div>
    <div class="row" style="margin-top:18px;gap:8px">
      <button class="btn" id="rl-copy">Copy link</button>
      <button class="btn ghost" id="rl-close">Done</button>
    </div>`, (root) => {
    $('#rl-copy', root).onclick = () => copyText(link);
    $('#rl-close', root).onclick = closeModal;
  });
}

/* -- performance -- */

async function renderInsights() {
  view.innerHTML = '<h1>Performance</h1><p class="sub">Loading…</p>';
  let data;
  try {
    data = await api('/api/insights');
  } catch (err) {
    view.innerHTML = `<h1>Performance</h1><div class="note warn">${esc(err.message)}</div>`;
    return;
  }

  const n = (v) => (v || 0).toLocaleString();
  const totals = data.creators.reduce((acc, r) => {
    acc.posts += r.posts; acc.views += r.views; acc.likes += r.likes;
    acc.comments += r.comments; acc.shares += r.shares;
    return acc;
  }, { posts: 0, views: 0, likes: 0, comments: 0, shares: 0 });

  view.innerHTML = `
    <div class="row between">
      <div><h1>Performance</h1><p class="sub" style="margin:0">Pulled from each platform, per creator.</p></div>
      <button class="btn ghost small" id="i-refresh">Refresh</button>
    </div>

    ${!data.hasData ? `<div class="card" style="margin-top:26px">
      <div class="eyebrow">Nothing to report yet</div>
      <p style="margin:0;color:var(--muted);line-height:1.6">
        Numbers appear once posts have actually published to a connected account. In dry run
        nothing reaches a platform, so there is nothing to read back — this stays empty on
        purpose rather than showing made-up figures.
      </p>
    </div>` : `
      <div class="hero-number" style="margin-top:22px">${n(totals.views)}</div>
      <p class="hero-note">views across <b>${totals.posts}</b> published posts</p>

      <h2>By creator</h2>
      <div class="card" style="margin-bottom:30px">
        ${data.creators.filter((r) => r.posts).map((r) => `<div class="list-row">
          ${avatar(r.creator)}
          <div style="flex:1"><div class="title">${esc(r.creator.name)}</div>
          <div class="meta">${r.posts} post${r.posts === 1 ? '' : 's'}${r.withData < r.posts ? ` · ${r.posts - r.withData} without numbers yet` : ''}</div></div>
          <div style="text-align:right;font-variant-numeric:tabular-nums">
            <div style="font-weight:650">${n(r.views)}</div>
            <div class="meta">${n(r.likes)} likes</div>
          </div>
        </div>`).join('') || '<div class="empty">No published posts yet.</div>'}
      </div>

      <h2>Top posts</h2>
      <div class="card">
        ${data.top.map((t) => {
          const account = accountById(t.accountId);
          return `<div class="list-row">
            <span class="dot" style="width:8px;height:8px;border-radius:50%;background:${platformMeta(account?.platform).color}"></span>
            <div style="flex:1;min-width:0">
              <div class="title" style="font-size:14px">${esc(t.caption || 'Untitled')}</div>
              <div class="meta">${esc(creatorById(t.creatorId)?.name || '')} · ${esc(account?.displayName || '')}</div>
            </div>
            <div style="text-align:right;font-variant-numeric:tabular-nums">
              <div style="font-weight:650">${n(t.views)}</div>
              <div class="meta">${n(t.likes)} likes</div>
            </div>
          </div>`;
        }).join('') || '<div class="empty">No numbers yet.</div>'}
      </div>`}`;

  $('#i-refresh').onclick = async () => {
    try {
      const { refreshed } = await api('/api/insights/refresh', { method: 'POST' });
      toast(refreshed ? `Refreshed ${refreshed} posts.` : 'No published posts to refresh.');
      render();
    } catch (err) { toast(err.message, true); }
  };
}

/* ------------------------------------------------------------------ modal */

function modal(html, bind) {
  closeModal();
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  scrim.innerHTML = `<div class="modal">${html}</div>`;
  scrim.onclick = (e) => { if (e.target === scrim) closeModal(); };
  document.body.appendChild(scrim);
  if (bind) bind(scrim);
}

function closeModal() {
  document.querySelector('.scrim')?.remove();
}

/* ------------------------------------------------------------------ route */

function go(name) {
  state.view = name;
  location.hash = name;
  render();
}

document.querySelectorAll('.nav-item').forEach((b) => {
  b.onclick = () => go(b.dataset.view);
});

document.getElementById('sign-out').onclick = async () => {
  await fetch('/api/session', { method: 'DELETE' });
  location.replace('/login.html');
};

window.addEventListener('hashchange', () => {
  const name = location.hash.replace('#', '').split('?')[0];
  if (name && name !== state.view) { state.view = name; render(); }
});

(async function boot() {
  const session = await fetch('/api/session').then((r) => r.json()).catch(() => ({}));
  if (!session.user) return location.replace('/login.html');
  state.me = session.user;

  const name = location.hash.replace('#', '').split('?')[0];
  if (name) state.view = name;
  await refresh();
  render();
  // Keep the queue honest while the tab is open — the scheduler is publishing
  // in the background whether or not anyone is looking.
  setInterval(async () => {
    if (document.querySelector('.scrim')) return;
    await refresh();
    if (state.view === 'today' || state.view === 'planner') render();
  }, 30_000);
}());
