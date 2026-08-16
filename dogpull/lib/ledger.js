'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { toCsv, createWriteQueue } = require('./util');

const STATE_DIRNAME = '.dogpull';
const LEDGER_VERSION = 1;

const MANIFEST_HEADERS = [
  'filename', 'title', 'video_id', 'upload_date', 'duration_min',
  'height', 'fps', 'vcodec', 'size_mb', 'downloaded_at', 'url',
];

async function writeJSONAtomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file);
}

async function readJSON(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}

/**
 * Tracks what has already been pulled, so a re-run never downloads the same
 * video twice. Keyed by YouTube video id rather than filename — a retitled
 * video is still the same video.
 *
 * The ledger lives beside the footage, so moving the drive moves the memory
 * with it.
 */
async function openLedger(destDir, channelUrl) {
  const stateDir = path.join(destDir, STATE_DIRNAME);
  const ledgerFile = path.join(stateDir, 'ledger.json');
  const cacheFile = path.join(stateDir, 'listing-cache.json');
  const probeFile = path.join(stateDir, 'probe-cache.json');

  const data = await readJSON(ledgerFile, {
    version: LEDGER_VERSION,
    channel: channelUrl,
    created_at: new Date().toISOString(),
    videos: {},
    failures: {},
  });
  data.videos = data.videos || {};
  data.failures = data.failures || {};

  const queue = createWriteQueue();
  const persist = () => queue(() => writeJSONAtomic(ledgerFile, data));

  return {
    file: ledgerFile,
    data,

    /**
     * True only if we recorded the video AND its file is still on disk, so a
     * deleted file is re-fetched instead of being skipped forever.
     */
    async isDownloaded(videoId) {
      const entry = data.videos[videoId];
      if (!entry?.file) return false;
      return fs.stat(entry.file).then(() => true).catch(() => false);
    },

    getEntry(videoId) {
      return data.videos[videoId] || null;
    },

    // Filenames come from video titles, which are not guaranteed unique.
    isNameTakenByAnother(filePath, videoId) {
      return Object.entries(data.videos).some(
        ([id, entry]) => id !== videoId && entry.file === filePath
      );
    },

    async recordSuccess(video, file, info, size) {
      const picked = Array.isArray(info?.requested_downloads) ? info.requested_downloads[0] : null;
      data.videos[video.id] = {
        title: info?.title || video.title || null,
        file,
        height: picked?.height ?? info?.height ?? null,
        fps: picked?.fps ?? info?.fps ?? null,
        vcodec: String(picked?.vcodec || info?.vcodec || '').split('.')[0] || null,
        duration: info?.duration ?? video.duration ?? null,
        upload_date: info?.upload_date ?? null,
        size,
        downloaded_at: new Date().toISOString(),
      };
      delete data.failures[video.id];
      await persist();
    },

    async recordFailure(video, reason) {
      const previous = data.failures[video.id];
      data.failures[video.id] = {
        title: video.title || null,
        reason,
        attempts: (previous?.attempts || 0) + 1,
        last_attempt: new Date().toISOString(),
      };
      await persist();
    },

    async writeManifest() {
      const rows = Object.entries(data.videos)
        .map(([id, v]) => {
          const d = String(v.upload_date || '');
          return {
            filename: v.file ? path.basename(v.file) : '',
            title: v.title || '',
            video_id: id,
            upload_date: d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d,
            duration_min: v.duration ? Math.round((v.duration / 60) * 10) / 10 : '',
            height: v.height ?? '',
            fps: v.fps ?? '',
            vcodec: v.vcodec || '',
            size_mb: v.size ? Math.round(v.size / 1_000_000) : '',
            downloaded_at: v.downloaded_at || '',
            url: `https://www.youtube.com/watch?v=${id}`,
          };
        })
        .sort((a, b) => String(b.upload_date).localeCompare(String(a.upload_date)));

      const file = path.join(destDir, 'DogPull Manifest.csv');
      await queue(() => fs.writeFile(file, toCsv(MANIFEST_HEADERS, rows)));
      return { file, count: rows.length };
    },

    // Listing a large channel takes real time; cache it so re-runs start fast.
    async readListingCache(maxAgeMs) {
      const cache = await readJSON(cacheFile, null);
      if (!cache?.fetched_at || cache.channel !== channelUrl) return null;
      const age = Date.now() - new Date(cache.fetched_at).getTime();
      if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) return null;
      return { videos: cache.videos || [], ageMs: age };
    },

    async writeListingCache(videos) {
      await writeJSONAtomic(cacheFile, {
        channel: channelUrl,
        fetched_at: new Date().toISOString(),
        videos,
      });
    },

    // Probing costs a network call per sampled video, and the answer only
    // changes when the requested quality does — so it is cached against a key.
    async readProbeCache(key, maxAgeMs) {
      const cached = await readJSON(probeFile, null);
      if (!cached || cached.key !== key) return null;
      const age = Date.now() - new Date(cached.probed_at).getTime();
      if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) return null;
      return cached.result;
    },

    async writeProbeCache(key, result) {
      await writeJSONAtomic(probeFile, {
        key,
        probed_at: new Date().toISOString(),
        result,
      });
    },
  };
}

module.exports = { openLedger, MANIFEST_HEADERS };
