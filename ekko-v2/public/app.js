// ==========================================================================
// Ekko frontend — vanilla JS, no build step
// Sections: state, api, dom, toasts, modal, status bar, views, router, init
// ==========================================================================

const state = {
  view: 'home',
  channels: [],
  jobs: [],
  stats: null,
  currentChannel: null,
  currentVideos: [],
  health: null,
  transcriptCursor: null,
  filters: { search: '', status: 'all', sort: 'date_desc' },
  // Track which job ids we've already toasted as "finished" so the SSE handler
  // doesn't fire a fresh toast on every reconnect / refresh.
  toastedFinishedJobIds: new Set(),
  // Customer-name-on-create saves keyed by jobId. The Home form captures the
  // name before the channel exists; we apply it once the job emits a channelKey.
  pendingCustomerNameByJobId: new Map(),
};

// ---- API ----
async function api(path, opts = {}) {
  const init = { headers: { 'content-type': 'application/json' }, ...opts };
  if (opts.body && typeof opts.body !== 'string') init.body = JSON.stringify(opts.body);
  const res = await fetch(path, init);
  const text = await res.text();
  if (!res.ok) {
    let msg = `${res.status}`;
    try { msg = JSON.parse(text).error || msg; } catch { msg = text || msg; }
    throw new Error(msg);
  }
  return text ? JSON.parse(text) : null;
}

async function apiBlob(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.blob();
}

// ---- DOM helpers ----
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function fmtDate(d) {
  if (!d) return '';
  const s = String(d);
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return s;
}
function fmtDuration(secs) {
  if (!secs && secs !== 0) return '';
  const s = Math.round(Number(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
           : `${m}:${String(r).padStart(2, '0')}`;
}
function fmtTimestamp(secs) {
  const s = Math.floor(secs);
  const m = Math.floor(s / 60);
  const r = s % 60;
  const hh = Math.floor(m / 60);
  return hh ? `${hh}:${String(m % 60).padStart(2, '0')}:${String(r).padStart(2, '0')}`
            : `${m}:${String(r).padStart(2, '0')}`;
}

// ---- Toasts ----
function toast(msg, { type = 'info', actions = [], timeout = 5000 } = {}) {
  const root = $('#toasts');
  const el = h('div', { class: `toast ${type}` },
    h('div', { class: 'toast-msg' }, msg),
    actions.length
      ? h('div', { class: 'toast-actions' },
          ...actions.map((a) => h('button', { onclick: () => { a.run(); el.remove(); } }, a.label)))
      : null,
  );
  root.appendChild(el);
  if (timeout) setTimeout(() => el.remove(), timeout);
  return el;
}
function toastError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return toast(msg, {
    type: 'error',
    timeout: 8000,
    actions: [{ label: 'Copy', run: () => navigator.clipboard?.writeText(msg) }],
  });
}

// ---- Modal ----
// Single global Esc handler shared across modal generations. When a modal opens
// on top of another (e.g. email preview from the export dialog), the previous
// modal's listener would otherwise leak onto document forever.
let activeModalCloser = null;
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && activeModalCloser) {
    e.preventDefault();
    activeModalCloser();
  }
});

function openModal({ title, body, footer, size }) {
  const root = $('#modal-root');
  const close = () => {
    root.innerHTML = '';
    if (activeModalCloser === close) activeModalCloser = null;
  };
  activeModalCloser = close;

  const modal = h('div', { class: `modal ${size === 'small' ? 'small' : ''}` },
    h('header', {},
      h('h3', {}, title),
      h('button', { class: 'ghost', onclick: close, title: 'Close (Esc)' }, '✕'),
    ),
    h('div', { class: 'body' }, body),
    footer ? h('footer', {}, footer) : null,
  );
  const backdrop = h('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) close(); } }, modal);
  root.innerHTML = '';
  root.appendChild(backdrop);
  return { close, modal };
}

// ---- Status bar / SSE ----
let evtSource = null;
function connectStream() {
  if (evtSource) return;
  try {
    evtSource = new EventSource('/api/jobs/stream');
    evtSource.addEventListener('jobs', (e) => {
      try {
        const next = JSON.parse(e.data);
        detectJobCompletions(state.jobs, next);
        applyPendingCustomerNames(next);
        state.jobs = next;
        renderStatusBar();
        renderNavCounts();
        if (state.view === 'jobs') renderJobsView();
        // Don't re-render Home from SSE — it would wipe whatever the user is
        // typing into the form. The status bar already shows live progress;
        // the stats card refreshes on completion via detectJobCompletions().
        if (state.view === 'channel') maybeRefreshChannelVideos(next);
      } catch (err) { console.error(err); }
    });
    evtSource.addEventListener('error', () => {
      // Browser auto-reconnects; just note transient state.
    });
  } catch (err) {
    console.error('SSE unsupported:', err);
  }
}

// Compare prev/next snapshots; when a job flips into a terminal state, fire a
// toast summary the user can click to jump to the channel.
function detectJobCompletions(prev, next) {
  const prevById = new Map(prev.map((j) => [j.id, j]));
  for (const j of next) {
    const before = prevById.get(j.id);
    const wasActive = before ? isJobActive(before) : false;
    const nowFinal = ['done', 'cancelled', 'error', 'interrupted'].includes(j.status);
    if (wasActive && nowFinal && !state.toastedFinishedJobIds.has(j.id)) {
      state.toastedFinishedJobIds.add(j.id);
      // Refresh channels + stats so the home stats card and sidebar reflect new totals.
      refreshChannels();
      refreshStats();
      toastJobFinished(j);
    }
  }
}

function toastJobFinished(j) {
  const p = j.progress || {};
  const ok = (p.done || 0) - (p.skipped || 0) - (p.failed || 0);
  if (j.status === 'done') {
    const summary = `${ok} archived, ${p.skipped || 0} skipped, ${p.failed || 0} failed`;
    toast(`✓ Pull complete — ${summary}`, {
      type: 'success',
      timeout: 9000,
      actions: j.channelKey
        ? [{ label: 'View channel', run: () => navigate('channel', { key: j.channelKey }) }]
        : [],
    });
  } else if (j.status === 'error') {
    toastError(new Error(j.error || 'Job failed'));
  } else if (j.status === 'cancelled') {
    toast('Pull cancelled', { type: 'info' });
  } else if (j.status === 'interrupted') {
    toast('Pull was interrupted by a server restart', { type: 'info', timeout: 6000 });
  }
}

function activeJobs() {
  return state.jobs.filter((j) =>
    ['starting', 'fetching-channel', 'listing-videos', 'archiving', 'cancelling'].includes(j.status)
  );
}

// While viewing a channel, if a pull is updating that same channel, re-fetch
// the video list and re-render JUST the table (toolbar + scroll position +
// search input focus all preserved). Throttled so we re-fetch at most every
// 2 seconds even if SSE ticks every 750ms.
let channelRefreshInFlight = false;
let channelRefreshScheduled = false;
function maybeRefreshChannelVideos(jobs) {
  if (!state.currentChannel) return;
  const key = state.currentChannel.key;
  const relevant = jobs.some((j) => j.channelKey === key && isJobActive(j));
  if (!relevant) return;
  if (channelRefreshInFlight) { channelRefreshScheduled = true; return; }
  channelRefreshInFlight = true;
  api(`/api/channels/${encodeURIComponent(key)}/videos`)
    .then((videos) => {
      // The user may have navigated away during the fetch; only patch state if
      // they're still on the same channel.
      if (state.currentChannel?.key === key) {
        state.currentVideos = videos;
        renderVideoTable();
      }
    })
    .catch((err) => console.warn('Channel auto-refresh failed:', err.message))
    .finally(() => {
      channelRefreshInFlight = false;
      if (channelRefreshScheduled) {
        channelRefreshScheduled = false;
        setTimeout(() => maybeRefreshChannelVideos(state.jobs), 2000);
      }
    });
}

function renderStatusBar() {
  const bar = $('#status-bar');
  const pill = $('#status-pill');
  const text = $('#status-text');
  const path = $('#vault-path');
  const active = activeJobs();
  bar.classList.toggle('has-jobs', active.length > 0);
  pill.classList.remove('idle', 'error', 'done');
  if (active.length) {
    const total = active.reduce((s, j) => s + (j.progress?.total || 0), 0);
    const done = active.reduce((s, j) => s + (j.progress?.done || 0), 0);
    let label = active.length === 1
      ? `Archiving ${done}/${total || '?'}`
      : `${active.length} jobs running · ${done}/${total || '?'}`;
    // Show the current video title from the single active job (if any).
    if (active.length === 1) {
      const t = active[0].progress?.currentTitle;
      if (t) label += ` · ${truncate(t, 60)}`;
    }
    text.textContent = label;
    pill.onclick = () => navigate('jobs');
    pill.style.cursor = 'pointer';
  } else {
    pill.classList.add('idle');
    text.textContent = 'Idle';
    pill.onclick = null;
  }
  if (state.health) path.textContent = state.health.vault;
}

function renderNavCounts() {
  $('#nav-job-count').textContent = String(activeJobs().length);
  // Keep the active-jobs tile on Home in sync without rebuilding the form.
  if (state.view === 'home') {
    const tiles = $$('.stats-card .stat-tile');
    if (tiles.length === 4) {
      const v = tiles[3].querySelector('.stat-value');
      if (v) v.textContent = String(activeJobs().length);
    }
  }
}

// ---- Channel list (sidebar) ----
function renderChannelList() {
  const list = $('#channel-list');
  list.innerHTML = '';
  if (!state.channels.length) {
    list.appendChild(h('div', { class: 'empty' }, 'No channels yet'));
    return;
  }
  for (const c of state.channels) {
    const item = h('div', {
      class: 'nav-item' + (state.currentChannel?.key === c.key && state.view === 'channel' ? ' active' : ''),
      onclick: () => navigate('channel', { key: c.key }),
    }, h('span', {}, c.title || c.key));
    list.appendChild(item);
  }
}

// ---- Views ----
function setView(name) {
  state.view = name;
  $$('.nav-item[data-view]').forEach((el) => {
    el.classList.toggle('active', el.dataset.view === name);
  });
  renderChannelList();
}

function renderHome() {
  setView('home');
  const main = $('#main');
  main.innerHTML = '';

  main.appendChild(h('div', { class: 'view-header' },
    h('div', {},
      h('h1', {}, 'Welcome to Ekko'),
      h('p', { class: 'subtitle' }, 'Pull a YouTube channel\'s entire transcript catalog into a local vault you own forever.'),
    ),
  ));

  // Vault stats card — derived from rolled-up totals on each channel record.
  const s = state.stats || { channels: 0, delivered: 0, total_videos: 0, total_words: 0 };
  const statsCard = h('div', { class: 'card stats-card' },
    statTile('Channels', String(s.channels), s.delivered ? `${s.delivered} delivered` : ''),
    statTile('Videos archived', s.total_videos.toLocaleString('en-US')),
    statTile('Total words', formatWordCountClient(s.total_words)),
    statTile('Active jobs', String(activeJobs().length)),
  );
  main.appendChild(statsCard);

  // Archive form card
  const form = h('form', { id: 'job-form', onsubmit: onStartJob },
    h('label', {}, 'Channel URL',
      h('input', { type: 'url', name: 'channelUrl', placeholder: 'https://www.youtube.com/@channel', required: true, autofocus: true })),
    h('label', {}, 'Customer name (optional — used in delivery email)',
      h('input', { type: 'text', name: 'customerName', placeholder: 'e.g. Jamie' })),
    h('label', {}, 'Subtitle language',
      h('input', { type: 'text', name: 'language', value: 'en' })),
    h('div', {}, h('button', { type: 'submit', class: 'primary' }, 'Start archive')),
  );
  const archiveCard = h('div', { class: 'card' }, h('h2', {}, 'Archive a channel'), form);
  main.appendChild(archiveCard);

  // Recent activity
  const recent = state.jobs.slice(0, 5);
  const recentCard = h('div', { class: 'card' }, h('h2', {}, 'Recent activity'));
  if (recent.length) {
    const tbl = h('table', {}, h('thead', {}, h('tr', {},
      h('th', {}, 'Status'), h('th', {}, 'Channel'), h('th', {}, 'Progress'), h('th', {}, ''),
    )));
    const tb = h('tbody', {});
    for (const j of recent) {
      const p = j.progress || {};
      const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
      tb.appendChild(h('tr', {},
        h('td', {}, h('span', { class: `tag ${jobStatusClass(j.status)}` }, j.status)),
        h('td', {}, j.channelUrl),
        h('td', {}, h('div', {},
          `${p.done || 0}/${p.total || 0}`,
          h('progress', { value: pct, max: 100 }),
        )),
        h('td', {}, isJobActive(j) ? h('button', { class: 'ghost', onclick: () => cancelJob(j.id) }, 'Cancel') : ''),
      ));
    }
    recentCard.appendChild(tbl);
    tbl.appendChild(tb);
  } else {
    recentCard.appendChild(emptyState({
      glyph: '◐', title: 'No archives yet',
      body: 'Paste a channel URL above to pull every transcript into your vault.',
    }));
  }
  main.appendChild(recentCard);

  if (!state.channels.length) {
    main.appendChild(h('div', { class: 'card' }, h('h2', {}, 'Your vault'),
      emptyState({
        glyph: '◇',
        title: 'Empty vault',
        body: 'Channels you archive will appear here. Each one is a folder of JSON metadata and VTT transcripts on your disk.',
      }),
    ));
  }
}

function statTile(label, value, sub) {
  return h('div', { class: 'stat-tile' },
    h('div', { class: 'stat-value' }, value),
    h('div', { class: 'stat-label' }, label),
    sub ? h('div', { class: 'stat-sub' }, sub) : null,
  );
}

// Mirror server-side formatWordCount so the home stats tile matches what the
// export pipeline would produce. Kept in sync manually with server/format.js.
function formatWordCountClient(n) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  if (v < 10000) return v.toLocaleString('en-US');
  if (v < 1000000) {
    const k = Math.round(v / 1000) * 1000;
    return k.toLocaleString('en-US');
  }
  const m = v / 1000000;
  const rounded = Math.round(m * 10) / 10;
  return `${m >= 10 ? Math.round(m) : rounded.toFixed(1)} million`;
}

function jobStatusClass(s) {
  if (s === 'done') return 'ok';
  if (s === 'error') return 'err';
  if (s === 'cancelled' || s === 'cancelling' || s === 'interrupted') return 'warn';
  return '';
}
function isJobActive(j) {
  return ['starting', 'fetching-channel', 'listing-videos', 'archiving', 'cancelling'].includes(j.status);
}

function renderJobsView() {
  setView('jobs');
  const main = $('#main');
  main.innerHTML = '';
  main.appendChild(h('div', { class: 'view-header' },
    h('div', {}, h('h1', {}, 'Jobs'), h('p', { class: 'subtitle' }, 'Live progress of every channel archive.')),
  ));
  const card = h('div', { class: 'card' });
  if (!state.jobs.length) {
    card.appendChild(emptyState({
      glyph: '◔', title: 'No jobs',
      body: 'Start an archive from Home to see live progress here.',
    }));
  } else {
    const tbl = h('table', {}, h('thead', {}, h('tr', {},
      h('th', {}, 'Status'), h('th', {}, 'Channel'), h('th', {}, 'Progress'),
      h('th', {}, 'Now pulling'), h('th', {}, 'Failed'), h('th', {}, 'Started'), h('th', {}, ''),
    )));
    const tb = h('tbody', {});
    for (const j of state.jobs) {
      const p = j.progress || {};
      const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
      const acts = h('div', { class: 'nav-arrows' });
      if (isJobActive(j)) acts.appendChild(h('button', { class: 'ghost', onclick: () => cancelJob(j.id) }, 'Cancel'));
      if (j.status === 'interrupted') {
        acts.appendChild(h('button', { class: 'primary', onclick: () => resumeJob(j) }, 'Resume'));
      }
      if (j.channelKey && (j.status === 'done' || j.status === 'cancelled' || j.status === 'interrupted')) {
        acts.appendChild(h('button', { onclick: () => navigate('channel', { key: j.channelKey }) }, 'Open'));
      }
      tb.appendChild(h('tr', {},
        h('td', {}, h('span', { class: `tag ${jobStatusClass(j.status)}` }, j.status)),
        h('td', {}, j.channelUrl),
        h('td', {}, h('div', {}, `${p.done || 0}/${p.total || 0}`, h('progress', { value: pct, max: 100 }))),
        h('td', { class: 'dim' }, isJobActive(j) && p.currentTitle ? truncate(p.currentTitle, 50) : ''),
        h('td', {}, String(p.failed || 0)),
        h('td', { class: 'dim' }, fmtDateTime(j.started_at)),
        h('td', {}, acts),
      ));
    }
    card.appendChild(tbl);
    tbl.appendChild(tb);
  }
  main.appendChild(card);
}

function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString();
}

async function renderChannelView(key) {
  setView('channel');
  state.view = 'channel';
  const main = $('#main');
  main.innerHTML = '';

  // Always re-fetch the canonical record so customer_name / delivered status
  // reflect any edits made elsewhere.
  let ch;
  try {
    ch = await api(`/api/channels/${encodeURIComponent(key)}`);
  } catch (_) {
    ch = state.channels.find((c) => c.key === key) || null;
  }
  if (!ch) {
    main.appendChild(emptyState({ glyph: '◌', title: 'Channel not found', body: 'It may have been deleted from your vault.' }));
    return;
  }
  state.currentChannel = ch;
  renderChannelList();

  const subtitleParts = [];
  if (ch.customer_name) subtitleParts.push(`For: ${ch.customer_name}`);
  if (ch.last_pull_finished_at) subtitleParts.push(`Last pulled ${fmtDateTime(ch.last_pull_finished_at)}`);
  else if (ch.fetched_at) subtitleParts.push(`Registered ${fmtDateTime(ch.fetched_at)}`);
  if (ch.delivered) subtitleParts.push('✓ Delivered');

  // Header
  main.appendChild(h('div', { class: 'view-header' },
    h('div', {},
      h('h1', {}, ch.title || ch.key),
      ch.url
        ? h('p', { class: 'subtitle' }, h('a', { href: ch.url, target: '_blank', rel: 'noopener' }, ch.url))
        : null,
      subtitleParts.length
        ? h('p', { class: 'subtitle dim', style: { marginTop: '0.25rem' } }, subtitleParts.join('  •  '))
        : null,
    ),
    h('div', { class: 'actions' },
      h('button', { class: 'primary', onclick: () => openExportDialog(ch) }, '⬇ Export Vault'),
      h('button', { onclick: () => startResumeFromUrl(ch.url) }, '↻ Pull new videos'),
      h('button', { onclick: () => openChannelEditDialog(ch) }, '✎ Edit'),
      h('button', { class: 'danger', onclick: () => confirmDeleteChannel(ch) }, '🗑 Delete'),
    ),
  ));

  if (ch.notes) {
    main.appendChild(h('div', { class: 'card notes-card' },
      h('div', { class: 'dim' }, 'Notes'),
      h('div', {}, ch.notes),
    ));
  }

  // Load videos
  const card = h('div', { class: 'card' });
  card.appendChild(h('div', {}, h('span', { class: 'spinner' }), ' Loading videos…'));
  main.appendChild(card);

  let videos;
  try {
    videos = await api(`/api/channels/${encodeURIComponent(key)}/videos`);
  } catch (err) {
    toastError(err);
    return;
  }
  state.currentVideos = videos;
  card.innerHTML = '';

  if (!videos.length) {
    card.appendChild(emptyState({
      glyph: '◌', title: 'No videos archived yet',
      body: 'This channel was registered but its video catalog hasn\'t been pulled. Try "Pull new videos" above.',
    }));
    return;
  }

  // Toolbar — search + transcript-status filter. Duration filter removed since
  // Shorts are always excluded by default.
  const toolbar = h('div', { class: 'toolbar' },
    h('div', { class: 'search-wrap' },
      h('input', {
        type: 'search', id: 'channel-search', placeholder: 'Search titles…',
        value: state.filters.search,
        oninput: (e) => { state.filters.search = e.target.value; renderVideoTable(); },
      }),
      h('span', { class: 'kbd-hint' }, '/'),
    ),
    h('select', { id: 'filter-status', value: state.filters.status,
      onchange: (e) => { state.filters.status = e.target.value; renderVideoTable(); } },
      h('option', { value: 'all' }, 'All transcripts'),
      h('option', { value: 'ok' }, 'Pulled OK'),
      h('option', { value: 'unavailable' }, 'Unavailable'),
    ),
    h('span', { class: 'dim', id: 'video-count-tag' }),
  );
  card.appendChild(toolbar);

  const tableWrap = h('div', { id: 'video-table-wrap' });
  card.appendChild(tableWrap);
  renderVideoTable();
}

// ---- Channel edit / delete ----
function openChannelEditDialog(ch) {
  const body = h('div', {},
    h('label', {}, 'Display title',
      h('input', { type: 'text', id: 'edit-title', value: ch.title || '' })),
    h('label', { style: { marginTop: '0.6rem' } }, 'Customer name',
      h('input', { type: 'text', id: 'edit-customer', value: ch.customer_name || '', placeholder: 'e.g. Jamie' })),
    h('label', { style: { marginTop: '0.6rem' } }, 'Notes (visible only to you)',
      h('textarea', { id: 'edit-notes', rows: 4, placeholder: 'Anything you want to remember about this channel.' }, ch.notes || '')),
    h('label', { class: 'row', style: { marginTop: '0.7rem' } },
      h('input', { type: 'checkbox', id: 'edit-delivered', checked: !!ch.delivered }),
      h('span', {}, 'Mark as delivered'),
    ),
  );
  const footer = h('div', {},
    h('span', { class: 'dim' }, ''),
    h('div', { class: 'nav-arrows' },
      h('button', { class: 'ghost', onclick: () => $('#modal-root').innerHTML = '' }, 'Cancel'),
      h('button', { class: 'primary', id: 'btn-save-channel', onclick: () => saveChannelEdits(ch) }, 'Save'),
    ),
  );
  openModal({ title: `Edit: ${ch.title || ch.key}`, body, footer, size: 'small' });
  // Set the textarea value programmatically — the h() helper passes children
  // as text nodes which work for empty textareas but the explicit set is safer.
  const ta = $('#edit-notes');
  if (ta) ta.value = ch.notes || '';
}

async function saveChannelEdits(ch) {
  const title = $('#edit-title').value;
  const customer_name = $('#edit-customer').value;
  const notes = $('#edit-notes').value;
  const delivered = $('#edit-delivered').checked;
  const btn = $('#btn-save-channel');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    await api(`/api/channels/${encodeURIComponent(ch.key)}`, {
      method: 'PATCH',
      body: { title, customer_name, notes, delivered },
    });
    toast('Channel updated', { type: 'success' });
    $('#modal-root').innerHTML = '';
    await refreshChannels();
    await renderChannelView(ch.key);
  } catch (err) {
    toastError(err);
    btn.disabled = false;
    btn.textContent = 'Save';
  }
}

function confirmDeleteChannel(ch) {
  const body = h('div', {},
    h('p', {}, h('strong', {}, ch.title || ch.key), ' will be permanently removed from your vault.'),
    h('p', { class: 'dim' }, 'This deletes the channel folder and every transcript inside it. You can re-pull from the same URL to bring it back, but any custom notes will be lost.'),
    h('label', {}, 'Type the channel name to confirm:',
      h('input', { type: 'text', id: 'confirm-name', placeholder: ch.title || ch.key, autofocus: true })),
  );
  const footer = h('div', {},
    h('span', { class: 'dim' }, ''),
    h('div', { class: 'nav-arrows' },
      h('button', { class: 'ghost', onclick: () => $('#modal-root').innerHTML = '' }, 'Cancel'),
      h('button', { class: 'danger', id: 'btn-delete-channel', onclick: () => doDeleteChannel(ch) }, 'Delete forever'),
    ),
  );
  openModal({ title: `Delete channel`, body, footer, size: 'small' });
}

async function doDeleteChannel(ch) {
  const typed = ($('#confirm-name')?.value || '').trim();
  const expected = (ch.title || ch.key).trim();
  if (typed !== expected) {
    toastError(new Error('Channel name doesn\'t match — refusing to delete.'));
    return;
  }
  const btn = $('#btn-delete-channel');
  btn.disabled = true;
  btn.textContent = 'Deleting…';
  try {
    await api(`/api/channels/${encodeURIComponent(ch.key)}`, { method: 'DELETE' });
    toast(`Deleted ${ch.title || ch.key}`, { type: 'success' });
    $('#modal-root').innerHTML = '';
    state.currentChannel = null;
    await refreshChannels();
    await refreshStats();
    navigate('home');
  } catch (err) {
    toastError(err);
    btn.disabled = false;
    btn.textContent = 'Delete forever';
  }
}

function applyFilters(videos) {
  const f = state.filters;
  let v = videos.slice();
  if (f.search) {
    const q = f.search.toLowerCase();
    v = v.filter((x) => (x.title || '').toLowerCase().includes(q));
  }
  if (f.status === 'ok') v = v.filter((x) => x.transcript_status === 'ok');
  if (f.status === 'unavailable') v = v.filter((x) => x.transcript_status !== 'ok');
  v.sort((a, b) => {
    switch (f.sort) {
      case 'date_asc': return String(a.upload_date || '').localeCompare(String(b.upload_date || ''));
      case 'duration_desc': return (b.duration || 0) - (a.duration || 0);
      case 'duration_asc': return (a.duration || 0) - (b.duration || 0);
      case 'segments_desc': return (b.transcript_segments || 0) - (a.transcript_segments || 0);
      case 'date_desc':
      default: return String(b.upload_date || '').localeCompare(String(a.upload_date || ''));
    }
  });
  return v;
}

function renderVideoTable() {
  const wrap = $('#video-table-wrap');
  if (!wrap) return;
  const filtered = applyFilters(state.currentVideos);
  $('#video-count-tag').textContent = `${filtered.length} of ${state.currentVideos.length}`;

  if (!filtered.length) {
    wrap.innerHTML = '';
    wrap.appendChild(h('div', { class: 'empty-state' }, h('h3', {}, 'No matches'), h('p', {}, 'Try clearing search or filters.')));
    return;
  }

  const sortArrow = (col) => state.filters.sort.startsWith(col)
    ? (state.filters.sort.endsWith('asc') ? ' ↑' : ' ↓') : '';
  const cycleSort = (col) => {
    const cur = state.filters.sort;
    state.filters.sort = cur === `${col}_desc` ? `${col}_asc` : `${col}_desc`;
    renderVideoTable();
  };

  const tbl = h('table', {},
    h('thead', {}, h('tr', {},
      h('th', { onclick: () => cycleSort('date') }, 'Date', h('span', { class: 'sort-arrow' }, sortArrow('date'))),
      h('th', {}, 'Title'),
      h('th', { onclick: () => cycleSort('duration') }, 'Duration', h('span', { class: 'sort-arrow' }, sortArrow('duration'))),
      h('th', { onclick: () => cycleSort('segments') }, 'Transcript', h('span', { class: 'sort-arrow' }, sortArrow('segments'))),
    )),
  );
  const tb = h('tbody', {});
  for (const v of filtered) {
    const status = v.transcript_status === 'ok'
      ? h('span', { class: 'tag ok', title: v.transcript_source === 'manual' ? 'Manually pasted' : '' },
          `${v.transcript_segments} segs${v.transcript_source === 'manual' ? ' ✎' : ''}`)
      : h('span', {
          class: 'tag warn',
          // Title shows the full reason on hover — the tag itself can only fit
          // about 60 chars before the table layout breaks.
          title: v.transcript_reason || '',
        }, v.transcript_reason ? truncate(v.transcript_reason, 60) : '—');
    const row = h('tr', {
      onclick: () => openTranscriptViewer(v, filtered),
    },
      h('td', { class: 'dim' }, fmtDate(v.upload_date)),
      h('td', {}, v.title || v.id),
      h('td', { class: 'dim' }, fmtDuration(v.duration)),
      h('td', {}, status),
    );
    tb.appendChild(row);
  }
  tbl.appendChild(tb);
  wrap.innerHTML = '';
  wrap.appendChild(tbl);
}

function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// ---- Transcript viewer modal ----
async function openTranscriptViewer(video, list) {
  if (!state.currentChannel) return;
  state.transcriptCursor = { list, index: list.findIndex((x) => x.id === video.id) };
  await showTranscript(state.transcriptCursor.index);
}

async function showTranscript(index) {
  if (!state.transcriptCursor) return;
  const list = state.transcriptCursor.list;
  index = Math.max(0, Math.min(index, list.length - 1));
  state.transcriptCursor.index = index;
  const v = list[index];
  const ch = state.currentChannel;

  let body;
  if (v.transcript_status !== 'ok') {
    const reason = v.transcript_reason || 'YouTube did not return captions for this video.';
    const looksLikeRateLimit = /429|too\s+many\s+requests|rate[- ]?limit/i.test(reason);
    const langs = Array.isArray(v.available_languages) ? v.available_languages : [];
    body = h('div', { class: 'empty-state' },
      h('h3', {}, 'No transcript available'),
      h('p', {}, reason),
      looksLikeRateLimit
        ? h('p', { class: 'dim', style: { fontSize: '0.8rem', marginTop: '0.4rem' } },
            'This was a YouTube rate limit, not a missing caption. Retrying usually pulls it.')
        : null,
      langs.length
        ? h('p', { class: 'dim', style: { fontSize: '0.8rem', marginTop: '0.4rem' } },
            `YouTube has captions in: ${langs.slice(0, 12).join(', ')}${langs.length > 12 ? '…' : ''}`)
        : null,
      h('div', { style: { display: 'flex', gap: '0.5rem', justifyContent: 'center', flexWrap: 'wrap', marginTop: '1.2rem' } },
        h('button', {
          class: 'primary',
          id: `btn-retry-${v.id}`,
          onclick: (e) => retryVideoPull(v, e.currentTarget),
        }, '↻ Retry pull'),
        h('a', { class: 'btn', href: v.url, target: '_blank', rel: 'noopener' }, '↗ Open on YouTube'),
        h('button', {
          onclick: () => openManualTranscriptDialog(v),
        }, '✎ Paste transcript manually'),
      ),
      h('p', { class: 'dim', style: { fontSize: '0.78rem', marginTop: '1rem', maxWidth: '32rem', marginLeft: 'auto', marginRight: 'auto' } },
        'Tip: open the video on YouTube, click "…" under the video → "Show transcript", click "Toggle timestamps" if you want segment timing, then copy and paste here.'),
    );
  } else {
    body = h('div', {}, h('div', { class: 'transcript-meta' }, h('span', {}, h('span', { class: 'spinner' }), ' Loading transcript…')));
    try {
      const data = await api(`/api/channels/${encodeURIComponent(ch.key)}/videos/${encodeURIComponent(v.id)}/transcript`);
      body = h('div', {},
        h('div', { class: 'transcript-meta' },
          h('span', {}, fmtDate(v.upload_date)),
          h('span', {}, `${fmtDuration(v.duration)} duration`),
          h('span', {}, `${data.segments.length} segments`),
          h('span', {}, h('a', { href: v.url, target: '_blank', rel: 'noopener' }, 'Open on YouTube ↗')),
        ),
        h('div', { class: 'transcript-segments' },
          ...data.segments.map((s) => h('div', { class: 'seg' },
            h('div', { class: 'ts' }, fmtTimestamp(s.start)),
            h('div', {}, s.text),
          )),
        ),
      );
    } catch (err) {
      body = h('div', { class: 'empty-state' }, h('h3', {}, 'Failed to load'), h('p', {}, err.message));
    }
  }

  const footer = h('div', {},
    h('span', { class: 'dim' }, `${index + 1} / ${list.length}`),
    h('div', { class: 'nav-arrows' },
      h('button', { onclick: () => showTranscript(index - 1), disabled: index === 0 }, '← Prev'),
      h('button', { onclick: () => showTranscript(index + 1), disabled: index === list.length - 1 }, 'Next →'),
    ),
  );
  openModal({ title: v.title || v.id, body, footer });
}

// ---- Retry a single video's transcript pull ----
async function retryVideoPull(v, btn) {
  const ch = state.currentChannel;
  if (!ch) return;
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Retrying — up to 2 min if rate-limited…';
  }
  try {
    const updated = await api(
      `/api/channels/${encodeURIComponent(ch.key)}/videos/${encodeURIComponent(v.id)}/retry`,
      { method: 'POST', body: { language: 'en' } },
    );

    // Patch the in-memory caches so the UI reflects the new state immediately.
    const idx = state.currentVideos.findIndex((x) => x.id === v.id);
    if (idx >= 0) state.currentVideos[idx] = updated;
    if (state.transcriptCursor) {
      const lidx = state.transcriptCursor.list.findIndex((x) => x.id === v.id);
      if (lidx >= 0) state.transcriptCursor.list[lidx] = updated;
    }
    refreshChannels();
    refreshStats();
    // Re-render the table behind the modal so the badge updates.
    if (state.view === 'channel') renderVideoTable();

    if (updated.transcript_status === 'ok') {
      toast('✓ Transcript pulled', { type: 'success' });
      // Re-open the modal at this index so the user sees the fresh transcript.
      if (state.transcriptCursor) {
        showTranscript(state.transcriptCursor.index);
      }
    } else if (updated.rate_limited) {
      toast('Still rate-limited. Wait a couple minutes, then try again.', { type: 'error', timeout: 8000 });
      if (btn) {
        btn.disabled = false;
        btn.textContent = '↻ Retry pull for this video';
      }
    } else {
      toast(`Still unavailable: ${truncate(updated.transcript_reason || '', 60)}`, { type: 'error' });
      if (btn) {
        btn.disabled = false;
        btn.textContent = '↻ Retry pull for this video';
      }
    }
  } catch (err) {
    toastError(err);
    if (btn) {
      btn.disabled = false;
      btn.textContent = '↻ Retry pull for this video';
    }
  }
}

// ---- Manual transcript paste ----
function openManualTranscriptDialog(v) {
  const ch = state.currentChannel;
  if (!ch) return;
  const body = h('div', {},
    h('p', { class: 'helper' },
      'Paste the transcript text from YouTube\'s "Show transcript" panel. ',
      'Timestamps are optional — if present, segments will be preserved.'),
    h('label', {}, 'Transcript text',
      h('textarea', {
        id: 'manual-transcript-text',
        rows: 14,
        placeholder: '0:00 hello and welcome\n0:03 today we\'re going to talk about…',
        autofocus: true,
      })),
    h('p', { class: 'dim', style: { fontSize: '0.78rem' } },
      'On YouTube: "…" under the video → Show transcript → Toggle timestamps → select all → copy.'),
  );
  const footer = h('div', {},
    h('span', { class: 'dim' }, ''),
    h('div', { class: 'nav-arrows' },
      h('button', { class: 'ghost', onclick: () => $('#modal-root').innerHTML = '' }, 'Cancel'),
      h('button', { class: 'primary', id: 'btn-save-manual', onclick: () => saveManualTranscript(v) }, 'Save transcript'),
    ),
  );
  openModal({ title: `Paste transcript: ${v.title || v.id}`, body, footer });
}

async function saveManualTranscript(v) {
  const text = $('#manual-transcript-text')?.value || '';
  if (!text.trim()) {
    return toastError(new Error('Paste some text first.'));
  }
  const ch = state.currentChannel;
  const btn = $('#btn-save-manual');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const updated = await api(
      `/api/channels/${encodeURIComponent(ch.key)}/videos/${encodeURIComponent(v.id)}/manual-transcript`,
      { method: 'POST', body: { text } },
    );
    // Patch caches and refresh views.
    const idx = state.currentVideos.findIndex((x) => x.id === v.id);
    if (idx >= 0) state.currentVideos[idx] = updated;
    if (state.transcriptCursor) {
      const lidx = state.transcriptCursor.list.findIndex((x) => x.id === v.id);
      if (lidx >= 0) state.transcriptCursor.list[lidx] = updated;
    }
    refreshChannels();
    refreshStats();
    if (state.view === 'channel') renderVideoTable();
    toast('✓ Transcript saved manually', { type: 'success' });
    $('#modal-root').innerHTML = '';
    if (state.transcriptCursor) showTranscript(state.transcriptCursor.index);
  } catch (err) {
    toastError(err);
    btn.disabled = false;
    btn.textContent = 'Save transcript';
  }
}

// ---- Export dialog ----
function openExportDialog(ch) {
  const body = h('div', {},
    h('p', { class: 'helper' }, 'Build a clean, shareable ZIP of every transcript in this channel.'),
    h('div', { class: 'checkbox-group' },
      h('label', { class: 'row' }, h('input', { type: 'checkbox', id: 'opt-individual', checked: true }), h('span', {}, 'Include individual transcript files')),
      h('label', { class: 'row' }, h('input', { type: 'checkbox', id: 'opt-srt' }), h('span', {}, 'Include SRT subtitle files')),
    ),
    h('label', {}, 'Customer name (used in delivery email)',
      h('input', { type: 'text', id: 'opt-customer', value: ch.customer_name || '', placeholder: 'e.g. Jamie' })),
    h('div', { style: { marginTop: '0.7rem' } },
      h('a', { href: '#', onclick: (e) => { e.preventDefault(); previewEmail(ch); } }, 'Preview delivery email →'),
    ),
  );
  const footer = h('div', {}, h('span', { class: 'dim' }, ''),
    h('div', { class: 'nav-arrows' },
      h('button', { class: 'ghost', onclick: () => $('#modal-root').innerHTML = '' }, 'Cancel'),
      h('button', { class: 'primary', id: 'btn-build-zip', onclick: () => buildZip(ch) }, 'Download Vault'),
    ),
  );
  openModal({ title: `Export: ${ch.title || ch.key}`, body, footer, size: 'small' });
}

async function buildZip(ch) {
  const includeIndividual = $('#opt-individual').checked;
  const includeSrt = $('#opt-srt').checked;
  const customer = ($('#opt-customer')?.value || '').trim();
  const btn = $('#btn-build-zip');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Building…';

  // Persist the customer name back onto the channel record so it sticks for
  // future exports, the email preview, and the channel header.
  if (customer && customer !== (ch.customer_name || '')) {
    try {
      await api(`/api/channels/${encodeURIComponent(ch.key)}`, {
        method: 'PATCH', body: { customer_name: customer },
      });
      refreshChannels();
    } catch (err) {
      console.warn('Could not persist customer name:', err.message);
    }
  }

  try {
    const url = `/api/channels/${encodeURIComponent(ch.key)}/export`
      + `?individual=${includeIndividual ? 1 : 0}`
      + `&srt=${includeSrt ? 1 : 0}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const cd = res.headers.get('content-disposition') || '';
    const m = cd.match(/filename="?([^"]+)"?/);
    const filename = m ? m[1] : `${ch.key}_EkkoVault.zip`;
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
    toast(`Exported ${filename}`, { type: 'success' });
    $('#modal-root').innerHTML = '';
  } catch (err) {
    toastError(err);
    btn.disabled = false;
    btn.textContent = 'Download Vault';
  }
}

async function previewEmail(ch) {
  const customer = $('#opt-customer')?.value || '';
  try {
    // Don't pass a downloadUrl — let the server keep the literal {DownloadURL}
    // placeholder so the operator sees clearly where to paste the real link.
    const url = `/api/channels/${encodeURIComponent(ch.key)}/delivery-email?customerName=${encodeURIComponent(customer)}`;
    const data = await api(url);
    const body = h('div', {},
      h('label', {}, 'Subject', h('input', { type: 'text', value: data.subject, readonly: true })),
      h('label', { style: { marginTop: '0.7rem' } }, 'Body',
        h('textarea', { rows: 14, readonly: true }, data.body)),
    );
    const footer = h('div', {}, h('span', { class: 'dim' }, 'Replace {DownloadURL} with your real link before sending.'),
      h('button', { class: 'primary', onclick: () => {
        navigator.clipboard?.writeText(`Subject: ${data.subject}\n\n${data.body}`);
        toast('Copied to clipboard', { type: 'success' });
      } }, 'Copy'),
    );
    openModal({ title: 'Delivery email preview', body, footer });
  } catch (err) {
    toastError(err);
  }
}

// ---- Settings ----
function renderSettings() {
  setView('settings');
  state.view = 'settings';
  const main = $('#main');
  main.innerHTML = '';
  main.appendChild(h('div', { class: 'view-header' }, h('div', {},
    h('h1', {}, 'Settings'), h('p', { class: 'subtitle' }, 'Where Ekko stores your vault and how it pulls captions.'),
  )));

  const vaultPath = state.health?.vault || '…';
  main.appendChild(h('div', { class: 'card' },
    h('h2', {}, 'Vault location'),
    h('p', { class: 'dim' }, 'All channel data is written here as JSON + VTT. Move it by setting the EKKOARCHIVE_VAULT environment variable before starting the app.'),
    h('code', { style: { display: 'block', padding: '0.55rem 0.7rem', background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: '6px', fontSize: '0.85rem', wordBreak: 'break-all' } }, vaultPath),
    h('div', { style: { marginTop: '0.7rem', display: 'flex', gap: '0.5rem' } },
      h('button', { onclick: () => copyText(vaultPath) }, 'Copy path'),
      h('button', { onclick: () => api('/api/reveal-vault', { method: 'POST' }).then(() => toast('Opening vault…', { type: 'success' })).catch(toastError) }, 'Reveal in file manager'),
    ),
  ));

  main.appendChild(h('div', { class: 'card' },
    h('h2', {}, 'Keyboard shortcuts'),
    h('table', {}, h('tbody', {},
      shortcutRow('/', 'Focus search on the current channel'),
      shortcutRow('Esc', 'Close any open dialog'),
      shortcutRow('← →', 'Previous / next transcript inside the viewer'),
      shortcutRow('g h', 'Go to Home'),
      shortcutRow('g j', 'Go to Jobs'),
      shortcutRow('g s', 'Go to Settings'),
    )),
  ));

  main.appendChild(h('div', { class: 'card' },
    h('h2', {}, 'yt-dlp'),
    h('p', { class: 'dim' }, 'YouTube changes their internals every few weeks. If you\'re seeing captions fail to pull on channels that used to work, update yt-dlp to the latest release.'),
    h('div', { style: { marginTop: '0.7rem' } },
      h('button', { id: 'btn-update-ytdlp', onclick: updateYtDlp }, '⤓ Update yt-dlp to latest'),
    ),
    h('p', { class: 'dim', id: 'ytdlp-update-status', style: { marginTop: '0.5rem', fontSize: '0.78rem' } }, ''),
  ));

  main.appendChild(h('div', { class: 'card' },
    h('h2', {}, 'About'),
    h('p', { class: 'dim' }, 'Ekko archives YouTube channel transcripts to a local vault you own. Everything runs on your machine — yt-dlp pulls captions, files stay on disk.'),
  ));
}

async function updateYtDlp() {
  const btn = $('#btn-update-ytdlp');
  const status = $('#ytdlp-update-status');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Downloading…';
  status.textContent = 'This usually takes 10–30 seconds depending on your connection.';
  try {
    const res = await api('/api/update-ytdlp', { method: 'POST' });
    toast('✓ yt-dlp updated', { type: 'success' });
    status.textContent = (res.output || '').split('\n').filter(Boolean).pop() || 'Updated.';
    btn.textContent = '⤓ Update again';
    btn.disabled = false;
  } catch (err) {
    toastError(err);
    status.textContent = 'Update failed: ' + err.message;
    btn.textContent = '⤓ Update yt-dlp to latest';
    btn.disabled = false;
  }
}

function shortcutRow(keys, label) {
  return h('tr', {},
    h('td', { style: { width: '110px' } }, ...keys.split(' ').map((k) => h('span', { class: 'kbd' }, k))),
    h('td', {}, label),
  );
}

function copyText(t) { navigator.clipboard?.writeText(t).then(() => toast('Copied', { type: 'success' })); }

// ---- Empty state helper ----
function emptyState({ glyph, title, body, action }) {
  return h('div', { class: 'empty-state' },
    glyph ? h('div', { class: 'glyph' }, glyph) : null,
    h('h3', {}, title),
    h('p', {}, body),
    action || null,
  );
}

// ---- Actions ----
async function onStartJob(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = {
    channelUrl: fd.get('channelUrl'),
    language: fd.get('language') || 'en',
  };
  // Guard: refuse to spawn a second pull for a URL that's already running.
  const dupActive = state.jobs.find((j) => j.channelUrl === body.channelUrl && isJobActive(j));
  if (dupActive) {
    return toast('A pull for that URL is already running.', { type: 'info' });
  }
  const customerName = (fd.get('customerName') || '').toString().trim();
  try {
    const { jobId } = await api('/api/jobs', { method: 'POST', body });
    toast('Archive started', { type: 'success' });

    // If a customer name was provided, save it onto the channel record once the
    // server has resolved the channelKey (the job emits it as soon as
    // fetching-channel completes). Poll the job briefly for the key.
    if (customerName) {
      saveCustomerNameWhenReady(jobId, customerName);
    }

    e.target.reset();
    e.target.querySelector('input[name=language]').value = 'en';
    await refreshChannels();
    navigate('jobs');
  } catch (err) {
    toastError(err);
  }
}

// Customer name comes in via the Home form before the channel exists. Stash it
// against the jobId; applyPendingCustomerNames() drains the map whenever the
// SSE update reveals a channelKey.
function saveCustomerNameWhenReady(jobId, customerName) {
  state.pendingCustomerNameByJobId.set(jobId, customerName);
  // Safety: drop after 5 minutes if for some reason no channelKey ever lands.
  setTimeout(() => state.pendingCustomerNameByJobId.delete(jobId), 5 * 60_000);
}

function applyPendingCustomerNames(jobs) {
  if (!state.pendingCustomerNameByJobId.size) return;
  for (const j of jobs) {
    if (!j.channelKey) continue;
    const name = state.pendingCustomerNameByJobId.get(j.id);
    if (!name) continue;
    state.pendingCustomerNameByJobId.delete(j.id);
    api(`/api/channels/${encodeURIComponent(j.channelKey)}`, {
      method: 'PATCH', body: { customer_name: name },
    }).then(() => refreshChannels())
      .catch((err) => console.warn('Failed to save customer name:', err.message));
  }
}

async function cancelJob(id) {
  try {
    await api(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
    toast('Cancelling…', { type: 'info' });
  } catch (err) { toastError(err); }
}

async function resumeJob(j) {
  await startResumeFromUrl(j.channelUrl);
}

async function startResumeFromUrl(url) {
  if (!url) return toastError(new Error('No source URL on this channel'));
  const dupActive = state.jobs.find((j) => j.channelUrl === url && isJobActive(j));
  if (dupActive) {
    return toast('A pull for this channel is already running — see Jobs.', { type: 'info' });
  }
  try {
    await api('/api/jobs', { method: 'POST', body: { channelUrl: url } });
    toast('Re-archive started — already-pulled videos will be skipped', { type: 'success' });
    navigate('jobs');
  } catch (err) { toastError(err); }
}

async function refreshChannels() {
  try {
    state.channels = await api('/api/channels');
    renderChannelList();
  } catch (err) { console.error(err); }
}

async function refreshStats() {
  try {
    state.stats = await api('/api/stats');
    // Refresh the on-screen tiles in place rather than re-rendering Home —
    // re-rendering would clobber whatever the user is typing in the form.
    if (state.view === 'home') updateStatsTiles();
  } catch (err) { console.error(err); }
}

// Patch the four stat tiles in place. Falls back silently if Home isn't
// currently rendered (the next renderHome() will paint the fresh numbers).
function updateStatsTiles() {
  const tiles = $$('.stats-card .stat-tile');
  if (tiles.length !== 4) return;
  const s = state.stats || { channels: 0, delivered: 0, total_videos: 0, total_words: 0 };
  const set = (i, value, sub) => {
    const v = tiles[i].querySelector('.stat-value');
    if (v) v.textContent = value;
    const sb = tiles[i].querySelector('.stat-sub');
    if (sb) sb.textContent = sub || '';
  };
  set(0, String(s.channels), s.delivered ? `${s.delivered} delivered` : '');
  set(1, s.total_videos.toLocaleString('en-US'), '');
  set(2, formatWordCountClient(s.total_words), '');
  set(3, String(activeJobs().length), '');
}

// ---- Router ----
function navigate(view, opts = {}) {
  const target = view === 'channel' && opts.key ? `#channel/${opts.key}` : `#${view}`;
  if (location.hash !== target) {
    location.hash = target;
  } else {
    handleRoute();
  }
}

async function handleRoute() {
  const hash = location.hash.replace(/^#/, '') || 'home';
  if (hash.startsWith('channel/')) {
    const key = decodeURIComponent(hash.slice('channel/'.length));
    await refreshChannels();
    await renderChannelView(key);
  } else if (hash === 'jobs') {
    renderJobsView();
  } else if (hash === 'settings') {
    renderSettings();
  } else {
    renderHome();
  }
}

// ---- Keyboard shortcuts ----
let pendingChord = null;
function onGlobalKey(e) {
  const tag = (e.target.tagName || '').toLowerCase();
  const inField = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;

  // '/' focuses channel search
  if (e.key === '/' && !inField) {
    const search = $('#channel-search');
    if (search) { e.preventDefault(); search.focus(); search.select(); }
    return;
  }

  // Esc handled inside modal but also clears chord
  if (e.key === 'Escape') {
    pendingChord = null;
    return;
  }

  // ←/→ only paginate when the transcript modal is the open one (detect by
  // looking for the segments container that only the transcript modal renders).
  if (state.transcriptCursor && $('.transcript-segments') && !inField) {
    if (e.key === 'ArrowLeft') { e.preventDefault(); showTranscript(state.transcriptCursor.index - 1); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); showTranscript(state.transcriptCursor.index + 1); return; }
  }

  // g-prefixed chords. Block when a modal is open so users editing channel
  // info don't accidentally teleport away.
  if (!inField && !$('.modal')) {
    if (pendingChord === 'g') {
      pendingChord = null;
      if (e.key === 'h') { e.preventDefault(); navigate('home'); return; }
      if (e.key === 'j') { e.preventDefault(); navigate('jobs'); return; }
      if (e.key === 's') { e.preventDefault(); navigate('settings'); return; }
    } else if (e.key === 'g') {
      pendingChord = 'g';
      setTimeout(() => { if (pendingChord === 'g') pendingChord = null; }, 800);
    }
  }
}

// ---- Sidebar nav clicks ----
document.addEventListener('click', (e) => {
  const navItem = e.target.closest('.nav-item[data-view]');
  if (navItem) navigate(navItem.dataset.view);
});

// ---- Init ----
async function init() {
  document.addEventListener('keydown', onGlobalKey);
  window.addEventListener('hashchange', handleRoute);
  try {
    state.health = await api('/api/health');
    $('#vault-path').textContent = state.health.vault;
  } catch (err) {
    console.error(err);
  }
  await refreshChannels();
  await refreshStats();
  connectStream();
  await handleRoute();
}

init();
