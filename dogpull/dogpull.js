#!/usr/bin/env node
'use strict';

/**
 * DogPull — pulls a YouTube channel's long-form catalogue down to the RM drive.
 *
 *   node dogpull.js --dry-run     see the plan, download nothing
 *   node dogpull.js               pull everything not already on the drive
 *
 * Files are named after the video title. Nothing is ever downloaded twice.
 */

const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const readline = require('node:readline/promises');

const {
  ytDlpInstalled, checkFfmpeg, getChannelMetadata, listChannelVideos, downloadVideo,
} = require('./lib/youtube');
const { openLedger } = require('./lib/ledger');
const {
  sanitizeTitle, channelVideosUrl, fmtBytes, fmtDuration, fmtElapsed, runPool, sleep,
} = require('./lib/util');

const RM_ROOT = path.resolve(__dirname, '..');
const CONFIG_FILE = path.join(__dirname, 'config.json');

// Rough YouTube bitrates (Mbps) for pre-flight sizing only.
const BITRATE = { 2160: 20, 1440: 9, 1080: 4.5, 720: 2.5, 480: 1.2, 360: 0.7 };

function estimateBytes(durationSec, height, fps) {
  if (!durationSec || durationSec <= 0) return 0;
  const rungs = Object.keys(BITRATE).map(Number).sort((a, b) => a - b);
  const rung = rungs.find((h) => h >= height) ?? rungs[rungs.length - 1];
  const mbps = BITRATE[rung] * (fps >= 50 ? 1.4 : 1) + 0.13;
  return Math.round((mbps * 1_000_000 / 8) * durationSec);
}

async function freeSpace(dir) {
  try {
    const s = await fs.statfs(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const flags = {};
  const withValue = new Set(['limit', 'dest', 'height', 'fps', 'jobs', 'min-duration']);
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const name = argv[i].slice(2);
    flags[name] = withValue.has(name) ? argv[++i] : true;
  }
  return flags;
}

function usage(config) {
  console.log(`
DogPull — bulk-pull a channel's long-form videos onto the RM drive.

  node dogpull.js [options]

Options:
  --dry-run          show exactly what would download, then stop
  --limit N          only the first N new videos (good for a test run)
  --oldest           start from the oldest upload (default: newest first)
  --jobs N           videos downloaded at once (default ${config.concurrency})
  --height N         max height (default ${config.height})
  --fps N            preferred frame rate (default ${config.fps})
  --min-duration S   anything shorter counts as a Short (default ${config.minDurationSec})
  --dest PATH        pull somewhere else, e.g. an external drive
  --refresh          re-list the channel instead of using the cached listing
  --retry-failed     retry videos that previously failed
  --yes              skip the confirmation prompt
  --help             this message

Currently configured: ${config.label} — ${config.channel} — up to ${config.height}p${config.fps}
`);
}

async function confirm(question) {
  if (!process.stdin.isTTY) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

function loadConfig() {
  const defaults = {
    label: 'Channel',
    channel: null,
    folderName: 'DogPull',
    destination: null,
    height: 2160,
    fps: 30,
    preferCodec: 'vp9',
    minDurationSec: 180,
    concurrency: 2,
    fragments: 8,
    listingCacheHours: 6,
  };
  let raw = {};
  try {
    raw = JSON.parse(fsSync.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`config.json is not valid JSON: ${e.message}`);
  }
  return { ...defaults, ...raw };
}

function expandHome(p) {
  return p.startsWith('~') ? path.join(process.env.HOME || '~', p.slice(1)) : p;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const config = loadConfig();

  if (flags.help) {
    usage(config);
    return 0;
  }

  const settings = {
    height: Number(flags.height) || config.height,
    fps: Number(flags.fps) || config.fps,
    preferCodec: config.preferCodec,
    minDurationSec: Number(flags['min-duration']) || config.minDurationSec,
    concurrency: Math.max(1, Number(flags.jobs) || config.concurrency),
    fragments: config.fragments,
  };
  // There is no H.264 above 1080p on YouTube, so never let that preference cap the run.
  if (settings.height > 1080 && settings.preferCodec === 'h264') settings.preferCodec = 'vp9';

  const listUrl = channelVideosUrl(config.channel);
  if (!listUrl) {
    console.error(`config.json has no usable YouTube channel: ${config.channel}`);
    return 1;
  }

  // ---- Preflight ---------------------------------------------------------
  if (!ytDlpInstalled()) {
    console.error('yt-dlp is missing. Run:  npm run setup');
    return 1;
  }
  const ffmpeg = await checkFfmpeg();
  if (!ffmpeg.ok && !flags['dry-run']) {
    console.error(`
ffmpeg was not found.

YouTube sends 4K as separate video and audio streams and yt-dlp needs ffmpeg to
merge them. Without it you would quietly get a lower-quality single file.

  macOS:  brew install ffmpeg
`);
    return 1;
  }

  const destDir = flags.dest
    ? path.resolve(expandHome(String(flags.dest)))
    : config.destination
      ? path.resolve(expandHome(config.destination))
      : path.join(RM_ROOT, 'DogPull', config.folderName);

  await fs.mkdir(destDir, { recursive: true });
  const ledger = await openLedger(destDir, listUrl);

  // ---- Listing (cached — re-listing a big channel is slow) ---------------
  const cacheMs = Math.max(0, Number(config.listingCacheHours) || 0) * 3600 * 1000;
  let videos = null;
  if (!flags.refresh && cacheMs > 0) {
    const cached = await ledger.readListingCache(cacheMs);
    if (cached) {
      videos = cached.videos;
      console.log(`\nUsing cached channel listing (${Math.round(cached.ageMs / 60000)} min old — --refresh to re-list).`);
    }
  }
  if (!videos) {
    console.log(`\nListing ${listUrl} ...`);
    const meta = await getChannelMetadata(listUrl).catch(() => null);
    if (meta) console.log(`Channel: ${meta.channel || meta.uploader || meta.title || '(unknown)'}`);
    videos = await listChannelVideos(listUrl);
    await ledger.writeListingCache(videos);
  }

  // ---- Filter to long form ----------------------------------------------
  const longForm = videos.filter((v) => {
    if (v.is_live || v.live_status === 'is_live' || v.live_status === 'is_upcoming') return false;
    if (typeof v.url === 'string' && v.url.includes('/shorts/')) return false;
    if (typeof v.duration === 'number' && v.duration > 0 && v.duration <= settings.minDurationSec) return false;
    return true;
  });

  // ---- Dedupe locally, before spending a single network call -------------
  const alreadyHave = [];
  const failedBefore = [];
  const pending = [];
  for (const v of longForm) {
    if (await ledger.isDownloaded(v.id)) { alreadyHave.push(v); continue; }
    if (ledger.data.failures[v.id] && !flags['retry-failed']) { failedBefore.push(v); continue; }
    pending.push(v);
  }

  const ordered = flags.oldest ? [...pending].reverse() : pending;
  const limit = Number(flags.limit) || 0;
  const queue = limit > 0 ? ordered.slice(0, limit) : ordered;

  const estimated = queue.reduce((sum, v) => sum + estimateBytes(v.duration, settings.height, settings.fps), 0);
  const free = await freeSpace(destDir);

  console.log(`
  Channel:      ${config.label}
  Long form:    ${longForm.length} videos on the channel
  Already have: ${alreadyHave.length}${failedBefore.length ? `   (plus ${failedBefore.length} previously failed — --retry-failed to retry)` : ''}
  To download:  ${queue.length}${limit && ordered.length > limit ? `  (limited from ${ordered.length})` : ''}
  Quality:      up to ${settings.height}p, preferring ${settings.fps}fps
  Destination:  ${destDir}
  Estimated:    ~${fmtBytes(estimated)}${free !== null ? `   (free on that drive: ${fmtBytes(free)})` : ''}
  Downloading:  ${settings.concurrency} at a time
`);

  if (!queue.length) {
    console.log('  Nothing new to pull — the drive is already up to date.\n');
    await ledger.writeManifest();
    return 0;
  }

  const preview = flags['dry-run'] ? queue : queue.slice(0, 8);
  for (const [i, v] of preview.entries()) {
    console.log(`  ${String(i + 1).padStart(3)}. [${fmtDuration(v.duration).padStart(7)}]  ${sanitizeTitle(v.title)}`);
  }
  if (queue.length > preview.length) console.log(`  ... and ${queue.length - preview.length} more`);

  if (free !== null && estimated > free) {
    console.log(`
  WARNING: the estimate is larger than the free space on that drive.
  Use --limit to pull in batches, or --dest to target a bigger drive.`);
  }

  if (flags['dry-run']) {
    console.log('\nDry run — nothing downloaded.\n');
    return 0;
  }

  if (!flags.yes && !(await confirm(`\nPull ${queue.length} videos (~${fmtBytes(estimated)}) to ${destDir}?`))) {
    console.log('Cancelled.\n');
    return 0;
  }

  // ---- Download ----------------------------------------------------------
  const controller = { abort: false };
  const active = new Map();
  const stats = { done: 0, failed: 0, bytes: 0, started: Date.now() };

  process.on('SIGINT', () => {
    if (controller.abort) process.exit(130);
    controller.abort = true;
    process.stdout.write('\nFinishing the current downloads, then stopping. Ctrl-C again to force quit.\n');
  });

  let lastLen = 0;
  const render = () => {
    const running = [...active.values()]
      .map((a) => `${a.title.slice(0, 28)} ${String(Math.round(a.percent)).padStart(3)}%`)
      .join('  |  ');
    const line =
      `  [${stats.done + stats.failed}/${queue.length}] ${fmtBytes(stats.bytes).padStart(8)}  ${running}`;
    process.stdout.write(`\r${line.slice(0, 150).padEnd(lastLen)}`);
    lastLen = Math.min(line.length, 150);
  };
  const ticker = setInterval(render, 500);

  // Names claimed by in-flight downloads. Two videos can share a title, and
  // with several running at once neither is in the ledger yet to reveal the clash.
  const reserved = new Set();
  const claimName = (video) => {
    const base = sanitizeTitle(video.title || video.id);
    const taken = (candidate) =>
      reserved.has(`${candidate}.mp4`) ||
      ledger.isNameTakenByAnother(`${candidate}.mp4`, video.id) ||
      fsSync.existsSync(`${candidate}.mp4`);
    let candidate = path.join(destDir, base);
    for (let n = 2; taken(candidate) && n <= 50; n++) {
      candidate = path.join(destDir, `${base} (${n})`);
    }
    reserved.add(`${candidate}.mp4`);
    return { base, outputBase: candidate };
  };

  await runPool(queue, settings.concurrency, async (video) => {
    if (controller.abort) return;

    const { base, outputBase } = claimName(video);
    active.set(video.id, { title: base, percent: 0 });
    const result = await downloadVideo(video.id, outputBase, { ...settings, controller },
      (p) => {
        const entry = active.get(video.id);
        if (entry) entry.percent = p.percent;
      });
    active.delete(video.id);

    if (result.ok) {
      const size = result.file ? await fs.stat(result.file).then((s) => s.size).catch(() => 0) : 0;
      stats.bytes += size;
      stats.done++;
      await ledger.recordSuccess(video, result.file, result.info, size);
      await ledger.writeManifest();
    } else if (!controller.abort) {
      stats.failed++;
      await ledger.recordFailure(video, result.reason);
    }
  });

  clearInterval(ticker);
  process.stdout.write(`\r${' '.repeat(lastLen)}\r`);

  const manifest = await ledger.writeManifest();

  console.log(`
  ${controller.abort ? 'Stopped early' : 'Done'} in ${fmtElapsed(Date.now() - stats.started)}
  Downloaded:  ${stats.done} videos (${fmtBytes(stats.bytes)})
  Failed:      ${stats.failed}
  On drive:    ${manifest.count} videos total
  Folder:      ${destDir}
  Manifest:    ${manifest.file}
`);

  if (stats.failed) {
    console.log('  Re-run with --retry-failed to try the failures again.\n');
    for (const [id, f] of Object.entries(ledger.data.failures).slice(0, 5)) {
      console.log(`    ${f.title || id}: ${String(f.reason).slice(0, 110)}`);
    }
    console.log('');
  }
  return 0;
}

// Set exitCode rather than calling process.exit(), which can truncate the
// final summary when stdout is a pipe.
main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    console.error(`\nDogPull failed: ${err.message}\n`);
    process.exitCode = 1;
  });
