const path = require('node:path');
const { spawn } = require('node:child_process');
const express = require('express');
const storage = require('./storage');
const {
  startArchiveJob, getJob, listJobs, cancelJob,
  loadPersistedJobs, subscribe,
} = require('./jobs');
const { isSafeChannelUrl } = require('./utils');
const { buildVaultZip } = require('./export');
const { renderDeliveryEmail } = require('./email');
const { formatWordCount } = require('./format');
const { parseVTT } = require('./transcripts');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, vault: storage.VAULT_ROOT });
});

app.get('/api/channels', async (_req, res, next) => {
  try { res.json(await storage.listChannels()); } catch (e) { next(e); }
});

app.get('/api/stats', async (_req, res, next) => {
  try { res.json(await storage.getVaultStats()); } catch (e) { next(e); }
});

app.get('/api/channels/:key', async (req, res, next) => {
  try {
    const c = await storage.getChannel(req.params.key);
    if (!c) return res.status(404).json({ error: 'Channel not found' });
    res.json(c);
  } catch (e) { next(e); }
});

app.patch('/api/channels/:key', async (req, res, next) => {
  try {
    const existing = await storage.getChannel(req.params.key);
    if (!existing) return res.status(404).json({ error: 'Channel not found' });

    const body = req.body || {};
    const patch = {};
    // Whitelist: only mutable user-set fields. Never overwrite the channel id,
    // url, etc. via PATCH — those are derived from yt-dlp metadata.
    if (typeof body.title === 'string') patch.title = body.title.trim().slice(0, 200);
    if (typeof body.customer_name === 'string') patch.customer_name = body.customer_name.trim().slice(0, 120);
    if (typeof body.notes === 'string') patch.notes = body.notes.trim().slice(0, 4000);
    if (typeof body.delivered === 'boolean') {
      patch.delivered = body.delivered;
      patch.delivered_at = body.delivered ? new Date().toISOString() : null;
    }
    const updated = await storage.patchChannelMeta(req.params.key, patch);
    res.json({ key: req.params.key, ...updated });
  } catch (e) { next(e); }
});

app.delete('/api/channels/:key', async (req, res, next) => {
  try {
    const existing = await storage.getChannel(req.params.key);
    if (!existing) return res.status(404).json({ error: 'Channel not found' });
    await storage.deleteChannel(req.params.key);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.get('/api/channels/:key/videos', async (req, res, next) => {
  try { res.json(await storage.listVideos(req.params.key)); } catch (e) { next(e); }
});

app.get('/api/channels/:key/videos/:videoId/transcript', async (req, res, next) => {
  try {
    const meta = await storage.getVideo(req.params.key, req.params.videoId);
    if (!meta) return res.status(404).json({ error: 'Video not found' });
    if (meta.transcript_status !== 'ok') {
      return res.status(404).json({ error: meta.transcript_reason || 'No transcript' });
    }
    const vtt = await storage.readTranscriptVtt(req.params.key, req.params.videoId);
    if (!vtt) return res.status(404).json({ error: 'Transcript file missing on disk' });
    const segments = parseVTT(vtt);
    res.json({
      id: meta.id,
      title: meta.title,
      url: meta.url,
      duration: meta.duration,
      upload_date: meta.upload_date,
      segments,
    });
  } catch (e) { next(e); }
});

app.get('/api/channels/:key/export', async (req, res, next) => {
  try {
    const opts = {
      individual: req.query.individual !== '0',
      srt: req.query.srt === '1',
    };
    const { buffer, filename } = await buildVaultZip(req.params.key, opts);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    res.end(buffer);
  } catch (e) { next(e); }
});

app.get('/api/channels/:key/delivery-email', async (req, res, next) => {
  try {
    const channel = await storage.getChannel(req.params.key);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });

    // Prefer the rolled-up totals on the channel record (cheap). Fall back to a
    // per-video sum if the channel was archived before rollups existed.
    let videoCount = Number(channel.total_videos);
    let totalWords = Number(channel.total_words);
    if (!Number.isFinite(videoCount) || !Number.isFinite(totalWords)) {
      const videos = await storage.listVideos(req.params.key);
      const ok = videos.filter((v) => v.transcript_status === 'ok');
      videoCount = ok.length;
      totalWords = ok.reduce((sum, v) => {
        if (Number.isFinite(v.word_count)) return sum + v.word_count;
        return sum;
      }, 0);
    }

    // Customer name precedence: explicit query param > stored channel record > "".
    const explicit = typeof req.query.customerName === 'string' ? req.query.customerName.trim() : '';
    const stored = typeof channel.customer_name === 'string' ? channel.customer_name.trim() : '';
    const customerName = explicit || stored || '';

    const rendered = await renderDeliveryEmail({
      channelName: channel.title || channel.key,
      customerName,
      downloadUrl: typeof req.query.downloadUrl === 'string' && req.query.downloadUrl
        ? req.query.downloadUrl : '{DownloadURL}',
      videoCount,
      wordCount: formatWordCount(totalWords),
    });
    res.json(rendered);
  } catch (e) { next(e); }
});

app.post('/api/jobs', async (req, res, next) => {
  try {
    const { channelUrl, includeShorts, language } = req.body || {};
    if (!isSafeChannelUrl(channelUrl)) {
      return res.status(400).json({ error: 'channelUrl must be a YouTube URL' });
    }
    const id = await startArchiveJob({
      channelUrl,
      includeShorts: !!includeShorts,
      language: typeof language === 'string' && language.trim() ? language.trim() : 'en',
    });
    res.json({ jobId: id });
  } catch (e) { next(e); }
});

app.get('/api/jobs', (_req, res) => res.json(listJobs()));

app.get('/api/jobs/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const send = (jobs) => {
    res.write(`event: jobs\n`);
    res.write(`data: ${JSON.stringify(jobs)}\n\n`);
  };

  // Send initial state, then subscribe to updates.
  send(listJobs());
  const unsub = subscribe(send);
  const heartbeat = setInterval(() => res.write(`: ping\n\n`), 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsub();
  });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  res.json(job);
});

app.post('/api/jobs/:id/cancel', (req, res) => {
  const ok = cancelJob(req.params.id);
  res.json({ ok });
});

app.post('/api/reveal-vault', (_req, res) => {
  const opener =
    process.platform === 'darwin' ? 'open' :
    process.platform === 'win32' ? 'explorer' :
    'xdg-open';
  try {
    const child = spawn(opener, [storage.VAULT_ROOT], { detached: true, stdio: 'ignore' });
    // Attach an error listener BEFORE unref — otherwise a missing opener (e.g.
    // xdg-open not installed) triggers an unhandled 'error' event that takes
    // the whole server down.
    child.on('error', (err) => {
      console.warn(`reveal-vault: failed to spawn '${opener}':`, err.message);
    });
    child.unref();
    res.json({ ok: true, opener });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

const port = Number(process.env.PORT) || 3939;
storage.ensureVault()
  .then(loadPersistedJobs)
  .then(() => {
    app.listen(port, '127.0.0.1', () => {
      console.log(`Ekko listening on http://localhost:${port}`);
      console.log(`Vault: ${storage.VAULT_ROOT}`);
    });
  });
