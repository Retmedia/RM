// ==========================================================================
// Ekko frontend — vanilla JS, no build step
// Sections: state, api, dom, toasts, modal, status bar, views, router, init
// ==========================================================================

const state = {
  view: 'home',
  channels: [],
  jobs: [],
  currentChannel: null,
  currentVideos: [],
  health: null,
  transcriptCursor: null,
  filters: { search: '', status: 'all', kind: 'all', sort: 'date_desc' },
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
function openModal({ title, body, footer, size }) {
  const root = $('#modal-root');
  const close = () => { root.innerHTML = ''; document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
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
        state.jobs = JSON.parse(e.data);
        renderStatusBar();
        renderNavCounts();
        if (state.view === 'jobs') renderJobsView();
        if (state.view === 'home') renderHome();
      } catch (err) { console.error(err); }
    });
    evtSource.addEventListener('error', () => {
      // Browser auto-reconnects; just note transient state.
    });
  } catch (err) {
    console.error('SSE unsupported:', err);
  }
}

function activeJobs() {
  return state.jobs.filter((j) =>
    ['starting', 'fetching-channel', 'listing-videos', 'archiving', 'cancelling'].includes(j.status)
  );
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
    text.textContent = active.length === 1
      ? `Archiving ${done}/${total || '?'}`
      : `${active.length} jobs running · ${done}/${total || '?'}`;
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
  if (state.view !== 'home') return;
  setView('home');
  const main = $('#main');
  main.innerHTML = '';

  main.appendChild(h('div', { class: 'view-header' },
    h('div', {},
      h('h1', {}, 'Welcome to Ekko'),
      h('p', { class: 'subtitle' }, 'Pull a YouTube channel\'s entire transcript catalog into a local vault you own forever.'),
    ),
  ));

  // Archive form card
  const form = h('form', { id: 'job-form', onsubmit: onStartJob },
    h('label', {}, 'Channel URL',
      h('input', { type: 'url', name: 'channelUrl', placeholder: 'https://www.youtube.com/@channel', required: true, autofocus: true })),
    h('label', {}, 'Subtitle language',
      h('input', { type: 'text', name: 'language', value: 'en' })),
    h('label', { class: 'row' },
      h('input', { type: 'checkbox', name: 'includeShorts' }),
      h('span', {}, 'Include Shorts (under 60s)'),
    ),
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
  if (state.view !== 'jobs') return;
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
      h('th', {}, 'Failed'), h('th', {}, 'Started'), h('th', {}, ''),
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
      tb.appendChild(h('tr', {},
        h('td', {}, h('span', { class: `tag ${jobStatusClass(j.status)}` }, j.status)),
        h('td', {}, j.channelUrl),
        h('td', {}, h('div', {}, `${p.done || 0}/${p.total || 0}`, h('progress', { value: pct, max: 100 }))),
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

  const ch = state.channels.find((c) => c.key === key);
  if (!ch) {
    main.appendChild(emptyState({ glyph: '◌', title: 'Channel not found', body: 'It may have been deleted from your vault.' }));
    return;
  }
  state.currentChannel = ch;
  renderChannelList();

  // Header
  main.appendChild(h('div', { class: 'view-header' },
    h('div', {},
      h('h1', {}, ch.title || ch.key),
      h('p', { class: 'subtitle' }, ch.url || ch.uploader || ''),
    ),
    h('div', { class: 'actions' },
      h('button', { onclick: () => openExportDialog(ch) }, '⬇ Export Vault'),
      h('button', { onclick: () => startResumeFromUrl(ch.url) }, '↻ Pull new videos'),
    ),
  ));

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

  // Toolbar
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
    h('select', { id: 'filter-kind', value: state.filters.kind,
      onchange: (e) => { state.filters.kind = e.target.value; renderVideoTable(); } },
      h('option', { value: 'all' }, 'All durations'),
      h('option', { value: 'long' }, 'Long-form (≥60s)'),
      h('option', { value: 'short' }, 'Shorts (<60s)'),
    ),
    h('span', { class: 'dim', id: 'video-count-tag' }),
  );
  card.appendChild(toolbar);

  const tableWrap = h('div', { id: 'video-table-wrap' });
  card.appendChild(tableWrap);
  renderVideoTable();
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
  if (f.kind === 'short') v = v.filter((x) => (x.duration ?? 999) < 60);
  if (f.kind === 'long') v = v.filter((x) => (x.duration ?? 0) >= 60);
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
      ? h('span', { class: 'tag ok' }, `${v.transcript_segments} segs`)
      : h('span', { class: 'tag warn' }, v.transcript_reason ? truncate(v.transcript_reason, 36) : '—');
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
    body = h('div', { class: 'empty-state' },
      h('h3', {}, 'No transcript available'),
      h('p', {}, v.transcript_reason || 'YouTube did not return captions for this video.'),
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

// ---- Export dialog ----
function openExportDialog(ch) {
  const body = h('div', {},
    h('p', { class: 'helper' }, 'Build a clean, shareable ZIP of every transcript in this channel.'),
    h('div', { class: 'checkbox-group' },
      h('label', { class: 'row' }, h('input', { type: 'checkbox', id: 'opt-individual', checked: true }), h('span', {}, 'Include individual transcript files')),
      h('label', { class: 'row' }, h('input', { type: 'checkbox', id: 'opt-srt' }), h('span', {}, 'Include SRT subtitle files')),
    ),
    h('label', {}, 'Customer name (optional, used in delivery email)',
      h('input', { type: 'text', id: 'opt-customer', placeholder: 'e.g. Jamie' })),
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
  const btn = $('#btn-build-zip');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Building…';
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
    const url = `/api/channels/${encodeURIComponent(ch.key)}/delivery-email?customerName=${encodeURIComponent(customer)}&downloadUrl=${encodeURIComponent('https://example.com/download')}`;
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
    h('h2', {}, 'About'),
    h('p', { class: 'dim' }, 'Ekko archives YouTube channel transcripts to a local vault you own. Everything runs on your machine — yt-dlp pulls captions, files stay on disk.'),
  ));
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
    includeShorts: fd.get('includeShorts') === 'on',
    language: fd.get('language') || 'en',
  };
  try {
    await api('/api/jobs', { method: 'POST', body });
    toast('Archive started', { type: 'success' });
    e.target.reset();
    e.target.querySelector('input[name=language]').value = 'en';
    await refreshChannels();
    navigate('jobs');
  } catch (err) {
    toastError(err);
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

  // ←/→ in transcript modal
  if (state.transcriptCursor && $('.modal') && !inField) {
    if (e.key === 'ArrowLeft') { e.preventDefault(); showTranscript(state.transcriptCursor.index - 1); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); showTranscript(state.transcriptCursor.index + 1); return; }
  }

  // g-prefixed chords
  if (!inField) {
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
  connectStream();
  await handleRoute();
}

init();
