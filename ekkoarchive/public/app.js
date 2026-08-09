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

async function refresh() {
  try {
    const [jobs, channels] = await Promise.all([
      api('/api/jobs'),
      api('/api/channels'),
    ]);

    const jobList = $('#jobs');
    jobList.innerHTML = jobs.length ? jobs.map((j) => {
      const p = j.progress || {};
      const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
      return `
        <li>
          <div><strong>${escapeHtml(j.status)}</strong> · ${escapeHtml(j.channelUrl)}</div>
          <div class="muted">${p.done || 0}/${p.total || 0} · in flight: ${p.in_flight || 0} · failed: ${p.failed || 0} · skipped: ${p.skipped || 0}</div>
          <progress value="${pct}" max="100"></progress>
          ${j.error ? `<div class="error">${escapeHtml(j.error)}</div>` : ''}
          ${(j.status === 'archiving' || j.status === 'starting' || j.status === 'fetching-channel' || j.status === 'listing-videos')
            ? `<button data-cancel="${escapeHtml(j.id)}">Cancel</button>` : ''}
        </li>`;
    }).join('') : '<li class="muted">No jobs yet.</li>';

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
    const okCount = videos.filter((v) => v.transcript_status === 'ok').length;
    $('#videos').innerHTML = `
      <h3>${escapeHtml(key)} — ${videos.length} videos · ${okCount} transcripts</h3>
      <table>
        <thead><tr><th>Date</th><th>Title</th><th>Duration</th><th>Transcript</th></tr></thead>
        <tbody>
          ${videos.map((v) => {
            const transcriptCell = v.transcript_status === 'ok'
              ? `<a href="/api/channels/${encodeURIComponent(key)}/videos/${encodeURIComponent(v.id)}/transcript" target="_blank" rel="noopener">${v.transcript_segments} segs</a>`
              : escapeHtml(v.transcript_reason || '—');
            return `
            <tr>
              <td>${escapeHtml(v.upload_date || '')}</td>
              <td><a href="${escapeHtml(v.url)}" target="_blank" rel="noopener">${escapeHtml(v.title || v.id)}</a></td>
              <td>${v.duration ? Math.round(v.duration / 60) + 'm' : ''}</td>
              <td>${transcriptCell}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;
  }
});

setInterval(refresh, 2500);
refresh();
