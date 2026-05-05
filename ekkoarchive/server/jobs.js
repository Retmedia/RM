const fs = require('node:fs/promises');
const { listChannelVideos, getChannelMetadata } = require('./youtube');
const { pullTranscript } = require('./transcripts');
const storage = require('./storage');
const { sleep } = require('./utils');

const jobs = new Map();

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

function cancelJob(id) {
  const state = jobs.get(id);
  if (!state) return false;
  state.controller.abort = true;
  if (state.status === 'archiving' || state.status === 'starting') {
    state.status = 'cancelling';
  }
  return true;
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
    controller: { abort: false },
  };
  jobs.set(id, state);

  run(state, { includeShorts, language }).catch((err) => {
    state.status = 'error';
    state.error = err.message;
    state.finished_at = new Date().toISOString();
  });

  return id;
}

async function run(state, { includeShorts, language }) {
  state.status = 'fetching-channel';
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

  if (state.controller.abort) { state.status = 'cancelled'; state.finished_at = new Date().toISOString(); return; }

  state.status = 'listing-videos';
  const all = await listChannelVideos(state.channelUrl);
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

  for (const v of filtered) {
    if (state.controller.abort) break;
    state.progress.current = v.id;

    const existing = await storage.getVideo(channelKey, v.id);
    if (existing && existing.transcript_status === 'ok') {
      state.progress.skipped++;
      state.progress.done++;
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

    await sleep(750);
  }

  state.progress.current = null;
  state.status = state.controller.abort ? 'cancelled' : 'done';
  state.finished_at = new Date().toISOString();
}

module.exports = { startArchiveJob, getJob, listJobs, cancelJob };
