const path = require('node:path');
const fs = require('node:fs/promises');
const { EventEmitter } = require('node:events');
const { listChannelVideos, getChannelMetadata } = require('./youtube');
const { pullTranscript } = require('./transcripts');
const storage = require('./storage');
const { sleep, writeJSONAtomic, readJSONIfExists } = require('./utils');

const ACTIVE_STATUSES = new Set([
  'starting', 'fetching-channel', 'listing-videos', 'archiving', 'cancelling',
]);

// YouTube raised the Shorts cap to 180s in late 2024. Detect Shorts via:
//   1) URL pattern (definitive when yt-dlp returns the /shorts/ form)
//   2) Duration < 60s (always-true Shorts heuristic that doesn't false-positive
//      on legitimate sub-3-minute long-form clips). 60–180s entries that don't
//      have a /shorts/ URL are treated as long-form to avoid eating real videos.
const SHORTS_DURATION_HEURISTIC_S = 60;
function isShort(v) {
  if (typeof v.url === 'string' && /\/shorts\//i.test(v.url)) return true;
  if (typeof v.duration === 'number' && v.duration > 0 && v.duration < SHORTS_DURATION_HEURISTIC_S) return true;
  return false;
}

const jobs = new Map();
const events = new EventEmitter();
events.setMaxListeners(0);

const JOBS_DIR = path.join(storage.VAULT_ROOT, '_jobs');

function jobsDir() { return JOBS_DIR; }
function jobFile(id) { return path.join(JOBS_DIR, `${id}.json`); }

function publicView(state) {
  const { controller, ...rest } = state;
  return rest;
}

function emit() {
  events.emit('jobs', listJobs());
}

async function persist(state) {
  try {
    await fs.mkdir(JOBS_DIR, { recursive: true });
    await writeJSONAtomic(jobFile(state.id), publicView(state));
  } catch (err) {
    console.error('Failed to persist job state:', err.message);
  }
}

function newJobId() {
  return `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function getJob(id) {
  const s = jobs.get(id);
  return s ? publicView(s) : null;
}

function listJobs() {
  return [...jobs.values()]
    .map(publicView)
    .sort((a, b) => String(b.started_at || '').localeCompare(String(a.started_at || '')));
}

function cancelJob(id) {
  const state = jobs.get(id);
  if (!state) return false;
  if (state.controller) state.controller.abort = true;
  if (ACTIVE_STATUSES.has(state.status) && state.status !== 'cancelling') {
    state.status = 'cancelling';
    persist(state);
    emit();
  }
  return true;
}

function setStatus(state, status) {
  state.status = status;
  persist(state);
  emit();
}

async function startArchiveJob({ channelUrl, includeShorts = false, language = 'en' }) {
  const id = newJobId();
  const state = {
    id,
    channelUrl,
    status: 'starting',
    started_at: new Date().toISOString(),
    finished_at: null,
    progress: { total: 0, done: 0, skipped: 0, failed: 0, current: null },
    error: null,
    channelKey: null,
    options: { includeShorts: !!includeShorts, language },
    controller: { abort: false },
  };
  jobs.set(id, state);
  await persist(state);
  emit();

  run(state).catch((err) => {
    state.status = 'error';
    state.error = err.message;
    state.finished_at = new Date().toISOString();
    persist(state);
    emit();
  });

  return id;
}

async function run(state) {
  const { includeShorts, language } = state.options;

  setStatus(state, 'fetching-channel');
  const meta = await getChannelMetadata(state.channelUrl);

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

  if (state.controller.abort) return finalize(state, 'cancelled');

  setStatus(state, 'listing-videos');
  const all = await listChannelVideos(state.channelUrl);
  const filtered = all.filter((v) => {
    if (!v.id) return false;
    if (v.is_live || v.live_status === 'is_live' || v.live_status === 'is_upcoming') return false;
    if (!includeShorts && isShort(v)) return false;
    return true;
  });

  state.progress.total = filtered.length;
  setStatus(state, 'archiving');

  const tDir = storage.transcriptDir(channelKey);
  await fs.mkdir(tDir, { recursive: true });

  for (const v of filtered) {
    if (state.controller.abort) break;
    state.progress.current = v.id;

    const existing = await storage.getVideo(channelKey, v.id);
    if (existing && existing.transcript_status === 'ok') {
      state.progress.skipped++;
      state.progress.done++;
      emit();
      continue;
    }

    const result = await pullTranscript(v.id, tDir, language);
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
      archived_at: new Date().toISOString(),
    };
    await storage.saveVideo(channelKey, record);

    if (!result.ok) state.progress.failed++;
    state.progress.done++;
    emit();
    persist(state);

    await sleep(750);
  }

  state.progress.current = null;
  finalize(state, state.controller.abort ? 'cancelled' : 'done');
}

function finalize(state, status) {
  state.status = status;
  state.finished_at = new Date().toISOString();
  persist(state);
  emit();
}

async function loadPersistedJobs() {
  try {
    await fs.mkdir(JOBS_DIR, { recursive: true });
    const entries = await fs.readdir(JOBS_DIR);
    for (const f of entries) {
      if (!f.endsWith('.json')) continue;
      const data = await readJSONIfExists(path.join(JOBS_DIR, f));
      if (!data || !data.id) continue;
      // Anything that was active when the process died is now interrupted.
      if (ACTIVE_STATUSES.has(data.status)) {
        data.status = 'interrupted';
        data.finished_at = data.finished_at || new Date().toISOString();
      }
      jobs.set(data.id, { ...data, controller: { abort: false } });
    }
    // Persist the corrected statuses back to disk.
    for (const s of jobs.values()) {
      if (s.status === 'interrupted' && !s.finished_at_persisted) {
        await persist(s);
        s.finished_at_persisted = true;
      }
    }
  } catch (err) {
    console.error('Failed to load persisted jobs:', err.message);
  }
}

function subscribe(handler) {
  events.on('jobs', handler);
  return () => events.off('jobs', handler);
}

module.exports = {
  startArchiveJob,
  getJob,
  listJobs,
  cancelJob,
  loadPersistedJobs,
  subscribe,
  jobsDir,
};
