const fs = require('node:fs/promises');
const { listChannelVideos, getChannelMetadata } = require('./youtube');
const { pullTranscript } = require('./transcripts');
const storage = require('./storage');
const { jitter, runWithConcurrency } = require('./utils');

const jobs = new Map();

// How many transcripts to pull at once. YouTube throttles aggressive clients,
// so keep this modest; override with EKKOARCHIVE_CONCURRENCY.
const DEFAULT_CONCURRENCY = clampConcurrency(process.env.EKKOARCHIVE_CONCURRENCY, 3);
// Cap how many finished jobs we retain in memory so the Map can't grow forever.
const MAX_FINISHED_JOBS = 50;

function clampConcurrency(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(8, Math.max(1, Math.floor(n)));
}

function newJobId() {
  return `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function publicView(state) {
  const { controller, ...rest } = state;
  return rest;
}

function getJob(id) {
  const s = jobs.get(id);
  return s ? publicView(s) : null;
}

function listJobs() {
  return [...jobs.values()].map(publicView);
}

function isTerminal(status) {
  return status === 'done' || status === 'error' || status === 'cancelled';
}

// Keep only the most recent finished jobs; running jobs are always retained.
function pruneJobs() {
  const finished = [...jobs.values()]
    .filter((s) => isTerminal(s.status))
    .sort((a, b) => String(a.finished_at || '').localeCompare(String(b.finished_at || '')));
  for (const s of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_JOBS))) {
    jobs.delete(s.id);
  }
}

function cancelJob(id) {
  const state = jobs.get(id);
  if (!state) return false;
  state.controller.abort();
  if (!isTerminal(state.status)) {
    state.status = 'cancelling';
  }
  return true;
}

async function startArchiveJob({ channelUrl, includeShorts = false, language = 'en', concurrency }) {
  const id = newJobId();
  const state = {
    id,
    channelUrl,
    status: 'starting',
    started_at: new Date().toISOString(),
    finished_at: null,
    concurrency: clampConcurrency(concurrency, DEFAULT_CONCURRENCY),
    progress: { total: 0, done: 0, skipped: 0, failed: 0, in_flight: 0, current: null },
    error: null,
    channelKey: null,
    controller: new AbortController(),
  };
  jobs.set(id, state);

  run(state, { includeShorts, language })
    .catch((err) => {
      state.status = 'error';
      state.error = err.message;
      state.finished_at = new Date().toISOString();
    })
    .finally(pruneJobs);

  return id;
}

async function run(state, { includeShorts, language }) {
  const { signal } = state.controller;

  state.status = 'fetching-channel';
  const meta = await getChannelMetadata(state.channelUrl, signal);

  const channelKey = storage.makeChannelKey(meta);
  state.channelKey = channelKey;

  await storage.saveChannelMeta(channelKey, {
    id: meta.channel_id || meta.id,
    title: meta.channel || meta.uploader || meta.title,
    uploader: meta.uploader,
    description: meta.description,
    url: state.channelUrl,
    fetched_at: new Date().toISOString(),
  });

  if (signal.aborted) return finish(state, 'cancelled');

  state.status = 'listing-videos';
  const all = await listChannelVideos(state.channelUrl, signal);
  const filtered = all.filter((v) => {
    if (!v.id) return false;
    if (v.is_live || v.live_status === 'is_live' || v.live_status === 'is_upcoming') return false;
    if (!includeShorts && typeof v.duration === 'number' && v.duration > 0 && v.duration < 60) return false;
    return true;
  });

  state.progress.total = filtered.length;
  state.status = 'archiving';

  const tDir = storage.transcriptDir(channelKey);
  await fs.mkdir(tDir, { recursive: true });

  await runWithConcurrency(
    filtered,
    (v) => archiveVideo(state, channelKey, tDir, v, language),
    state.concurrency,
    () => signal.aborted
  );

  state.progress.current = null;
  finish(state, signal.aborted ? 'cancelled' : 'done');
}

async function archiveVideo(state, channelKey, tDir, v, language) {
  const { signal } = state.controller;
  if (signal.aborted) return;

  state.progress.in_flight++;
  state.progress.current = v.id;
  try {
    const existing = await storage.getVideo(channelKey, v.id);
    if (existing && existing.transcript_status === 'ok') {
      state.progress.skipped++;
      state.progress.done++;
      return;
    }

    const result = await pullTranscript(v.id, tDir, language, signal);

    // Don't record a partial write for a cancelled pull.
    if (signal.aborted && result.reason === 'cancelled') return;

    const record = {
      id: v.id,
      title: v.title || existing?.title || null,
      url: v.url || `https://www.youtube.com/watch?v=${v.id}`,
      duration: v.duration ?? null,
      upload_date: v.upload_date ?? null,
      view_count: v.view_count ?? null,
      thumbnail: v.thumbnail ?? null,
      description: v.description ?? null,
      transcript_status: result.ok ? 'ok' : 'unavailable',
      transcript_reason: result.ok ? null : result.reason,
      transcript_segments: result.ok ? result.segments.length : 0,
      transcript_file: result.ok ? result.file : null,
      transcript_text_file: result.ok ? result.textFile : null,
      archived_at: new Date().toISOString(),
    };
    await storage.saveVideo(channelKey, record);

    if (!result.ok) state.progress.failed++;
    state.progress.done++;

    // Gentle, jittered pacing between requests to stay under YouTube's radar.
    if (!signal.aborted) await jitter(250, 500);
  } finally {
    state.progress.in_flight--;
  }
}

function finish(state, status) {
  state.status = status;
  state.finished_at = new Date().toISOString();
}

module.exports = { startArchiveJob, getJob, listJobs, cancelJob };
