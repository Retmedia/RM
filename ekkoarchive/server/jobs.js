const fs = require('node:fs/promises');
const path = require('node:path');
const { listChannelVideos, getChannelMetadata } = require('./youtube');
const { pullTranscript } = require('./transcripts');
const {
  downloadVideo, checkFfmpeg, ytDlpInstalled,
  estimateBytes, freeSpaceBytes, bytesToGb,
  DEFAULT_HEIGHT, DEFAULT_FPS,
} = require('./downloads');
const storage = require('./storage');
const { sleep, channelVideosUrl } = require('./utils');

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
  if (['archiving', 'downloading', 'starting', 'fetching-channel', 'listing-videos'].includes(state.status)) {
    state.status = 'cancelling';
  }
  return true;
}

async function startArchiveJob({ channelUrl, includeShorts = false, language = 'en' }) {
  const id = newJobId();
  const state = {
    id,
    kind: 'archive',
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

// Shorts can run up to 3 minutes now, so "long form" defaults to over 3 minutes
// rather than the 60s cut-off the transcript archiver uses.
function selectLongForm(videos, { minDurationSec = 180, limit = 0, order = 'newest' } = {}) {
  const filtered = videos.filter((v) => {
    if (!v.id) return false;
    if (v.is_live || v.live_status === 'is_live' || v.live_status === 'is_upcoming') return false;
    if (typeof v.url === 'string' && v.url.includes('/shorts/')) return false;
    if (typeof v.duration === 'number' && v.duration > 0 && v.duration <= minDurationSec) return false;
    return true;
  });
  // The /videos tab arrives newest-first; the flat listing often has no
  // upload_date, so trust that ordering instead of sorting by a missing field.
  const ordered = order === 'oldest' ? [...filtered].reverse() : filtered;
  return limit > 0 ? ordered.slice(0, limit) : ordered;
}

function manifestRowFrom(info, file, sizeBytes) {
  const picked = Array.isArray(info.requested_downloads) ? info.requested_downloads[0] : null;
  const height = picked?.height ?? info.height ?? null;
  const fps = picked?.fps ?? info.fps ?? null;
  const vcodec = String(picked?.vcodec || info.vcodec || '').split('.')[0];
  const d = String(info.upload_date || '');
  return {
    filename: file ? path.basename(file) : '',
    video_id: info.id,
    title: info.title || '',
    upload_date: d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d,
    duration_min: info.duration ? Math.round((info.duration / 60) * 10) / 10 : '',
    height: height ?? '',
    fps: fps ?? '',
    vcodec: vcodec === 'none' ? '' : vcodec,
    size_mb: sizeBytes ? Math.round(sizeBytes / 1_000_000) : '',
    url: `https://www.youtube.com/watch?v=${info.id}`,
  };
}

async function startDownloadJob(opts) {
  const {
    channelUrl,
    height = DEFAULT_HEIGHT,
    fps = DEFAULT_FPS,
    minDurationSec = 180,
    limit = 0,
    order = 'newest',
    destDir = null,
    label = null,
  } = opts;

  // YouTube has no H.264 above 1080p, so preferring it at 4K is meaningless —
  // normalize here rather than trusting every caller to remember.
  const preferH264 = height > 1080 ? false : opts.preferH264 !== false;

  if (!ytDlpInstalled()) {
    throw new Error('yt-dlp is not installed — run: npm run install-ytdlp');
  }
  const ffmpeg = await checkFfmpeg();
  if (!ffmpeg.ok) {
    throw new Error(
      'ffmpeg was not found. yt-dlp needs it to merge YouTube\'s separate video and audio ' +
      'streams — without it you silently get a lower-quality single-file version. ' +
      'Install with: brew install ffmpeg (macOS) — then start EkkoArchive again.'
    );
  }

  const id = newJobId();
  const state = {
    id,
    kind: 'download',
    label,
    channelUrl,
    status: 'starting',
    started_at: new Date().toISOString(),
    finished_at: null,
    settings: { height, fps, preferH264, minDurationSec, limit, order },
    destDir,
    warning: null,
    progress: {
      total: 0, done: 0, skipped: 0, failed: 0,
      current: null, currentTitle: null, percent: 0, speed: null, eta: null,
      bytes: 0, estimated_gb: 0,
    },
    error: null,
    channelKey: null,
    controller: { abort: false },
  };
  jobs.set(id, state);

  runDownload(state, { height, fps, preferH264, minDurationSec, limit, order, destDir })
    .catch((err) => {
      state.status = 'error';
      state.error = err.message;
      state.finished_at = new Date().toISOString();
    });

  return id;
}

async function runDownload(state, opts) {
  const listUrl = channelVideosUrl(state.channelUrl) || state.channelUrl;

  state.status = 'fetching-channel';
  const meta = await getChannelMetadata(listUrl);
  const channelKey = storage.makeChannelKey(meta);
  state.channelKey = channelKey;
  state.channelTitle = meta.channel || meta.uploader || meta.title || null;

  await storage.saveChannelMeta(channelKey, {
    id: meta.channel_id || meta.id,
    title: state.channelTitle,
    uploader: meta.uploader,
    description: meta.description,
    url: state.channelUrl,
    fetched_at: new Date().toISOString(),
  });

  if (state.controller.abort) return finishDownload(state);

  state.status = 'listing-videos';
  const all = await listChannelVideos(listUrl);
  const selected = selectLongForm(all, opts);
  state.progress.total = selected.length;

  const destDir = opts.destDir || storage.downloadDir(channelKey);
  state.destDir = destDir;
  await fs.mkdir(destDir, { recursive: true });

  const estimated = selected.reduce(
    (sum, v) => sum + estimateBytes(v.duration, opts.height, opts.fps), 0
  );
  state.progress.estimated_gb = bytesToGb(estimated);

  const free = await freeSpaceBytes(destDir);
  if (free !== null && estimated > free) {
    state.warning =
      `Estimated ${bytesToGb(estimated)} GB needed but only ${bytesToGb(free)} GB free on ` +
      `${destDir}. The run will stop when the disk fills — point destDir at a bigger drive ` +
      'or use the limit option to grab them in batches.';
  }

  state.status = 'downloading';

  // Seed the manifest from anything a previous run already pulled.
  const existingRecords = await storage.listVideos(channelKey);
  const manifest = new Map(
    existingRecords
      .filter((v) => v.download_status === 'ok' && v.download_manifest)
      .map((v) => [v.id, v.download_manifest])
  );

  for (const v of selected) {
    if (state.controller.abort) break;
    state.progress.current = v.id;
    state.progress.currentTitle = v.title || v.id;
    state.progress.percent = 0;

    const existing = await storage.getVideo(channelKey, v.id);
    if (existing?.download_status === 'ok' && existing.download_file) {
      const stillThere = await fs.stat(existing.download_file).catch(() => null);
      if (stillThere) {
        state.progress.skipped++;
        state.progress.done++;
        continue;
      }
    }

    const result = await downloadVideo(
      v.id,
      destDir,
      { ...opts, controller: state.controller },
      (p) => {
        state.progress.percent = p.percent;
        state.progress.speed = p.speed;
        state.progress.eta = p.eta;
      }
    );

    if (result.ok) {
      const size = result.file
        ? await fs.stat(result.file).then((s) => s.size).catch(() => 0)
        : 0;
      const row = manifestRowFrom(result.info, result.file, size);
      manifest.set(v.id, row);
      state.progress.bytes += size;

      await storage.mergeVideo(channelKey, v.id, {
        id: v.id,
        title: result.info.title || v.title || null,
        url: `https://www.youtube.com/watch?v=${v.id}`,
        duration: result.info.duration ?? v.duration ?? null,
        upload_date: result.info.upload_date ?? null,
        download_status: 'ok',
        download_reason: null,
        download_file: result.file,
        download_height: row.height || null,
        download_fps: row.fps || null,
        download_size_bytes: size,
        download_manifest: row,
        downloaded_at: new Date().toISOString(),
      });
      await storage.writeManifest(destDir, [...manifest.values()]);
    } else {
      state.progress.failed++;
      await storage.mergeVideo(channelKey, v.id, {
        id: v.id,
        title: v.title || null,
        url: `https://www.youtube.com/watch?v=${v.id}`,
        download_status: 'failed',
        download_reason: result.reason,
        downloaded_at: new Date().toISOString(),
      });
    }

    state.progress.done++;
    await sleep(750);
  }

  await storage.writeManifest(destDir, [...manifest.values()]);
  finishDownload(state);
}

function finishDownload(state) {
  state.progress.current = null;
  state.progress.currentTitle = null;
  state.progress.percent = 0;
  state.status = state.controller.abort ? 'cancelled' : 'done';
  state.finished_at = new Date().toISOString();
}

module.exports = {
  startArchiveJob,
  startDownloadJob,
  selectLongForm,
  getJob,
  listJobs,
  cancelJob,
};
