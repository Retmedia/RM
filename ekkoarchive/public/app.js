const $ = (s, r = document) => r.querySelector(s);

async function api(path, opts = {}) {
  const init = { headers: { 'content-type': 'application/json' }, ...opts };
  if (opts.body && typeof opts.body !== 'string') init.body = JSON.stringify(opts.body);
  const res = await fetch(path, init);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

$('#job-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = {
    channelUrl: fd.get('channelUrl'),
    includeShorts: fd.get('includeShorts') === 'on',
    language: fd.get('language') || 'en',
  };
  try {
    await api('/api/jobs', { method: 'POST', body });
    e.target.reset();
    e.target.querySelector('input[name=language]').value = 'en';
    refresh();
  } catch (err) {
    alert(err.message);
  }
});

$('#download-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = {
    channelUrl: fd.get('channelUrl'),
    height: Number(fd.get('height')),
    fps: Number(fd.get('fps')),
    limit: Number(fd.get('limit')) || 0,
    order: fd.get('order'),
    destDir: fd.get('destDir') || null,
  };
  // No H.264 above 1080p on YouTube — asking for it would cap the run at 1080.
  if (body.height > 1080) body.preferH264 = false;
  try {
    await api('/api/downloads', { method: 'POST', body });
    e.target.querySelector('input[name=channelUrl]').value = '';
    refresh();
  } catch (err) {
    alert(err.message);
  }
});

const ACTIVE = ['archiving', 'downloading', 'starting', 'fetching-channel', 'listing-videos', 'cancelling'];

function jobLine(j) {
  const p = j.progress || {};
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  const name = j.label || j.channelUrl;
  const detail = j.kind === 'download'
    ? `${p.done || 0}/${p.total || 0} · failed: ${p.failed || 0} · already had: ${p.skipped || 0}` +
      `${p.estimated_gb ? ` · ~${p.estimated_gb} GB` : ''}` +
      `${p.currentTitle ? `<br>${escapeHtml(p.currentTitle)} — ${Math.round(p.percent || 0)}%${p.speed ? ` at ${escapeHtml(p.speed)}` : ''}${p.eta ? `, ETA ${escapeHtml(p.eta)}` : ''}` : ''}`
    : `${p.done || 0}/${p.total || 0} · failed: ${p.failed || 0} · skipped: ${p.skipped || 0}`;
  return `
    <li>
      <div><strong>${escapeHtml(j.status)}</strong> · ${escapeHtml(j.kind || 'archive')} · ${escapeHtml(name)}</div>
      <div class="muted">${detail}</div>
      <progress value="${pct}" max="100"></progress>
      ${j.warning ? `<div class="error">${escapeHtml(j.warning)}</div>` : ''}
      ${j.error ? `<div class="error">${escapeHtml(j.error)}</div>` : ''}
      ${ACTIVE.includes(j.status) ? `<button data-cancel="${escapeHtml(j.id)}">Cancel</button>` : ''}
    </li>`;
}

async function refresh() {
  try {
    const [jobs, channels] = await Promise.all([
      api('/api/jobs'),
      api('/api/channels'),
    ]);

    const jobList = $('#jobs');
    jobList.innerHTML = jobs.length
      ? jobs.map(jobLine).join('')
      : '<li class="muted">No jobs yet.</li>';

    const channelList = $('#channels');
    channelList.innerHTML = channels.length ? channels.map((c) => `
      <li><a href="#" data-channel="${escapeHtml(c.key)}">${escapeHtml(c.title || c.key)}</a></li>
    `).join('') : '<li class="muted">No channels archived yet.</li>';
  } catch (err) {
    console.error(err);
  }
}

document.body.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-cancel],[data-channel]');
  if (!t) return;
  const cancelId = t.getAttribute('data-cancel');
  if (cancelId) {
    await api(`/api/jobs/${encodeURIComponent(cancelId)}/cancel`, { method: 'POST' });
    refresh();
    return;
  }
  const key = t.getAttribute('data-channel');
  if (key) {
    e.preventDefault();
    const videos = await api(`/api/channels/${encodeURIComponent(key)}/videos`);
    $('#videos').innerHTML = `
      <h3>${escapeHtml(key)} — ${videos.length} videos</h3>
      <table>
        <thead><tr><th>Date</th><th>Title</th><th>Duration</th><th>Transcript</th><th>Video file</th></tr></thead>
        <tbody>
          ${videos.map((v) => `
            <tr>
              <td>${escapeHtml(v.upload_date || '')}</td>
              <td><a href="${escapeHtml(v.url)}" target="_blank" rel="noopener">${escapeHtml(v.title || v.id)}</a></td>
              <td>${v.duration ? Math.round(v.duration / 60) + 'm' : ''}</td>
              <td>${v.transcript_status === 'ok' ? `${v.transcript_segments} segs` : escapeHtml(v.transcript_reason || '—')}</td>
              <td>${v.download_status === 'ok'
                ? `${v.download_height || '?'}p${v.download_fps ? Math.round(v.download_fps) : ''} · ${Math.round((v.download_size_bytes || 0) / 1_000_000)} MB`
                : v.download_status === 'failed' ? '<span class="error">failed</span>' : '—'}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  }
});

async function loadTooling() {
  try {
    const [health, clients] = await Promise.all([api('/api/health'), api('/api/clients')]);

    $('#client-list').innerHTML = clients
      .map((c) => `<option value="${escapeHtml(c.channelUrl)}">${escapeHtml(c.label)} — ${c.height}p${c.fps}</option>`)
      .join('');

    const missing = [];
    if (!health.ytdlp) missing.push('yt-dlp (run: npm run install-ytdlp)');
    if (!health.ffmpeg) missing.push('ffmpeg (run: brew install ffmpeg) — required to merge 1080p/4K video with audio');
    const status = $('#tool-status');
    status.className = missing.length ? 'error' : 'muted';
    status.textContent = missing.length ? `Missing: ${missing.join(' · ')}` : `Vault: ${health.vault}`;
  } catch (err) {
    console.error(err);
  }
}

setInterval(refresh, 1500);
refresh();
loadTooling();
