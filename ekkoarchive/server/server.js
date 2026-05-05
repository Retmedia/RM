const path = require('node:path');
const express = require('express');
const storage = require('./storage');
const { startArchiveJob, getJob, listJobs, cancelJob } = require('./jobs');
const { isSafeChannelUrl } = require('./utils');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, vault: storage.VAULT_ROOT });
});

app.get('/api/channels', async (_req, res, next) => {
  try { res.json(await storage.listChannels()); } catch (e) { next(e); }
});

app.get('/api/channels/:key/videos', async (req, res, next) => {
  try { res.json(await storage.listVideos(req.params.key)); } catch (e) { next(e); }
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

app.get('/api/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  res.json(job);
});

app.post('/api/jobs/:id/cancel', (req, res) => {
  const ok = cancelJob(req.params.id);
  res.json({ ok });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

const port = Number(process.env.PORT) || 3939;
storage.ensureVault().then(() => {
  app.listen(port, '127.0.0.1', () => {
    console.log(`EkkoArchive listening on http://localhost:${port}`);
    console.log(`Vault: ${storage.VAULT_ROOT}`);
  });
});
