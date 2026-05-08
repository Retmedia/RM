const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const express = require('express');
const storage = require('./storage');
const {
  startArchiveJob, startRetryUnavailableJob, startRefreshMetadataJob,
  getJob, listJobs, cancelJob,
  loadPersistedJobs, subscribe,
} = require('./jobs');
const { isSafeChannelUrl } = require('./utils');
const { buildVaultZip } = require('./export');
const { renderDeliveryEmail } = require('./email');
const { formatWordCount, wordCount, parsePastedTranscript, segmentsToVtt } = require('./format');
const { parseVTT, pullTranscript } = require('./transcripts');

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

// Backfill upload_date / view_count / description for every video on the
// channel. Cheap (no captions cross the wire) and safe to run on channels
// that already have transcripts pulled.
app.post('/api/channels/:key/refresh-metadata', async (req, res, next) => {
  try {
    const channel = await storage.getChannel(req.params.key);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });

    const ACTIVE = ['starting', 'fetching-channel', 'listing-videos', 'archiving', 'cancelling'];
    const dup = listJobs().find((j) => j.channelKey === req.params.key && ACTIVE.includes(j.status));
    if (dup) {
      return res.status(409).json({ error: 'A pull is already running for this channel — see Jobs.' });
    }

    const id = await startRefreshMetadataJob({ channelKey: req.params.key });
    res.json({ jobId: id });
  } catch (e) { next(e); }
});

// Bulk re-pull every transcript that came back unavailable on the original
// archive. Saves the operator from clicking Retry on each failed video one by
// one — common after a rate-limit-heavy pull. Returns a jobId; progress is
// surfaced via the standard /api/jobs/stream SSE feed.
app.post('/api/channels/:key/retry-unavailable', async (req, res, next) => {
  try {
    const channel = await storage.getChannel(req.params.key);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });

    const videos = await storage.listVideos(req.params.key);
    const count = videos.filter((v) => v.transcript_status !== 'ok').length;
    if (count === 0) {
      return res.status(400).json({ error: 'Nothing to retry — every video already has a transcript.' });
    }

    // Refuse if a pull is already in flight for this channel — two concurrent
    // jobs would race each other's writes to the same videos/<id>.json files.
    const ACTIVE = ['starting', 'fetching-channel', 'listing-videos', 'archiving', 'cancelling'];
    const dup = listJobs().find((j) => j.channelKey === req.params.key && ACTIVE.includes(j.status));
    if (dup) {
      return res.status(409).json({ error: 'A pull is already running for this channel — see Jobs.' });
    }

    const language = (req.body && typeof req.body.language === 'string' && req.body.language.trim()) || 'en';
    const id = await startRetryUnavailableJob({ channelKey: req.params.key, language });
    res.json({ jobId: id, count });
  } catch (e) { next(e); }
});

// Manually re-pull the transcript for one video — used by the "Retry" button
// in the transcript modal when YouTube rate-limited the original pull. This
// can take 1–2 minutes if the rate-limit retry ladder kicks in (10s/30s/90s).
app.post('/api/channels/:key/videos/:videoId/retry', async (req, res, next) => {
  try {
    const channel = await storage.getChannel(req.params.key);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    const existing = await storage.getVideo(req.params.key, req.params.videoId);
    if (!existing) return res.status(404).json({ error: 'Video not found' });

    const tDir = storage.transcriptDir(req.params.key);
    await fs.mkdir(tDir, { recursive: true });
    const language = (req.body && typeof req.body.language === 'string' && req.body.language.trim()) || 'en';

    const result = await pullTranscript(req.params.videoId, tDir, language);
    const segText = result.ok ? result.segments.map((s) => s.text).join(' ') : '';
    const info = result.info || {};
    const updated = {
      ...existing,
      // Backfill metadata fields if --write-info-json gave us fresh values.
      title: info.title || existing.title,
      duration: info.duration ?? existing.duration ?? null,
      upload_date: info.upload_date || existing.upload_date || null,
      view_count: info.view_count ?? existing.view_count ?? null,
      thumbnail: info.thumbnail || existing.thumbnail || null,
      description: info.description ?? existing.description ?? null,
      transcript_status: result.ok ? 'ok' : 'unavailable',
      transcript_reason: result.ok ? null : result.reason,
      transcript_segments: result.ok ? result.segments.length : (existing.transcript_segments || 0),
      transcript_file: result.ok ? result.file : existing.transcript_file,
      transcript_source: result.ok ? 'yt-dlp' : (existing.transcript_source || null),
      available_languages: result.available_languages || existing.available_languages || null,
      word_count: result.ok ? wordCount(segText) : (existing.word_count || 0),
      archived_at: new Date().toISOString(),
    };
    await storage.saveVideo(req.params.key, updated);
    await storage.recomputeChannelTotals(req.params.key);
    res.json({ ...updated, rate_limited: !!result.rateLimited });
  } catch (e) { next(e); }
});

// Manual transcript paste — operator pastes text from YouTube's "Show
// transcript" panel for videos where yt-dlp can't pull the captions.
// Synthesises a VTT and saves it like any other transcript so the export
// pipeline picks it up unchanged.
app.post('/api/channels/:key/videos/:videoId/manual-transcript', async (req, res, next) => {
  try {
    const channel = await storage.getChannel(req.params.key);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    const existing = await storage.getVideo(req.params.key, req.params.videoId);
    if (!existing) return res.status(404).json({ error: 'Video not found' });

    const text = req.body && typeof req.body.text === 'string' ? req.body.text : '';
    if (!text.trim()) return res.status(400).json({ error: 'Empty transcript' });

    const segments = parsePastedTranscript(text, existing.duration || 999_999);
    if (!segments.length) return res.status(400).json({ error: 'Could not parse anything from that paste' });

    const vtt = segmentsToVtt(segments);
    const tDir = storage.transcriptDir(req.params.key);
    await fs.mkdir(tDir, { recursive: true });
    const filename = `${req.params.videoId}.manual.vtt`;
    await fs.writeFile(path.join(tDir, filename), vtt);

    const segText = segments.map((s) => s.text).join(' ');
    const updated = {
      ...existing,
      transcript_status: 'ok',
      transcript_reason: null,
      transcript_segments: segments.length,
      transcript_file: filename,
      transcript_source: 'manual',
      word_count: wordCount(segText),
      archived_at: new Date().toISOString(),
    };
    await storage.saveVideo(req.params.key, updated);
    await storage.recomputeChannelTotals(req.params.key);
    res.json(updated);
  } catch (e) { next(e); }
});

// Re-download the yt-dlp binary in place. YouTube changes their internals
// every few weeks; an old yt-dlp can stop pulling captions even when they
// exist. Operators should run this if they see a sudden uptick in
// "no captions" failures across normally-OK channels.
app.post('/api/update-ytdlp', (_req, res) => {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'install-yt-dlp.mjs');
  const child = spawn(process.execPath, [scriptPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { err += d.toString(); });
  child.on('error', (e) => res.status(500).json({ error: e.message }));
  child.on('close', (code) => {
    if (code === 0) res.json({ ok: true, output: out.trim() });
    else res.status(500).json({ error: (err || out || `exit ${code}`).trim() });
  });
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

  let closed = false;
  const stop = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsub();
  };

  // Wrap every write so a closed socket can't bring the server down via an
  // unhandled 'error' event. Express's res.write on a destroyed connection
  // will emit ECONNRESET / EPIPE; we'd rather note it and unsubscribe.
  const send = (jobs) => {
    if (closed || res.writableEnded || res.destroyed) return stop();
    try {
      res.write(`event: jobs\n`);
      res.write(`data: ${JSON.stringify(jobs)}\n\n`);
    } catch (err) {
      console.warn('SSE write failed, dropping subscriber:', err.message);
      stop();
    }
  };

  send(listJobs());
  const unsub = subscribe(send);
  const heartbeat = setInterval(() => {
    if (closed || res.writableEnded || res.destroyed) return stop();
    try { res.write(`: ping\n\n`); } catch { stop(); }
  }, 25_000);

  // Belt-and-braces: 'close' on the request, 'close' on the response, and
  // an 'error' listener on the socket all converge on stop().
  req.on('close', stop);
  res.on('close', stop);
  res.on('error', stop);
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
