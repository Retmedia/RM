#!/usr/bin/env node
/**
 * Bulk-download a channel's long-form videos.
 *
 *   npm run download -- xander
 *   npm run download -- blair --limit 3
 *   npm run download -- @somechannel --height 1080 --fps 60 --dest ~/Movies/Clips
 *
 * Always shows the channel it resolved, the video count and a size estimate,
 * and waits for confirmation before it downloads anything.
 */
const path = require('node:path');
const readline = require('node:readline/promises');
const { getChannelMetadata, listChannelVideos } = require('../server/youtube');
const { startDownloadJob, getJob, cancelJob, selectLongForm } = require('../server/jobs');
const { getClient, listClients, markVerified } = require('../server/clients');
const storage = require('../server/storage');
const {
  checkFfmpeg, ytDlpInstalled, estimateBytes, freeSpaceBytes, bytesToGb,
  DEFAULT_HEIGHT, DEFAULT_FPS,
} = require('../server/downloads');
const { channelVideosUrl, normalizeChannelUrl, sleep } = require('../server/utils');

function parseArgs(argv) {
  const opts = { target: null, flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      if (!opts.target) opts.target = arg;
      continue;
    }
    const name = arg.slice(2);
    const valueFlags = ['limit', 'height', 'fps', 'dest', 'min-duration'];
    if (valueFlags.includes(name)) {
      opts.flags[name] = argv[++i];
    } else {
      opts.flags[name] = true;
    }
  }
  return opts;
}

function usage() {
  const clients = listClients();
  console.log(`
Bulk-download long-form videos from a YouTube channel.

  npm run download -- <client|@handle|url> [options]

Options:
  --limit N          only the first N videos (great for a test run)
  --oldest           start from the oldest upload (default: newest first)
  --height N         max height, e.g. 2160, 1080, 720   (default ${DEFAULT_HEIGHT})
  --fps N            preferred frame rate, e.g. 60, 30  (default ${DEFAULT_FPS})
  --min-duration S   treat anything shorter as a Short  (default 180)
  --dest PATH        where the files land (default: the vault's downloads folder)
  --dry-run          list what would download, then stop
  --yes              skip the confirmation prompt

Saved clients:
${clients.length
    ? clients.map((c) => `  ${c.key.padEnd(8)} ${c.label} — ${c.height}p${c.fps} — ${c.channelUrl}${c.verified ? '' : '  (unverified)'}`).join('\n')
    : '  (none — add them to clients.json)'}
`);
}

function fmtGb(bytes) {
  return `${bytesToGb(bytes)} GB`;
}

function fmtDuration(sec) {
  if (!sec) return '?';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

async function confirm(question) {
  if (!process.stdin.isTTY) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function main() {
  const { target, flags } = parseArgs(process.argv.slice(2));

  if (!target || flags.help) {
    usage();
    process.exit(flags.help ? 0 : 1); // asking for help is success; no args at all is not
  }

  if (!ytDlpInstalled()) {
    console.error('yt-dlp is not installed yet. Run:  npm run install-ytdlp');
    process.exit(1);
  }
  // A dry run only lists videos, so it doesn't need ffmpeg — warn instead of blocking.
  const ffmpeg = await checkFfmpeg();
  if (!ffmpeg.ok) {
    const message =
      '\nffmpeg was not found.\n\n' +
      'YouTube serves 1080p and 4K as separate video and audio streams, and yt-dlp needs\n' +
      'ffmpeg to merge them. Without it you quietly get a lower-quality single-file version.\n\n' +
      '  macOS:  brew install ffmpeg\n' +
      '  Linux:  sudo apt install ffmpeg\n';
    if (!flags['dry-run']) {
      console.error(message);
      process.exit(1);
    }
    console.warn(`${message}\nContinuing — a dry run only lists videos.`);
  }

  const client = getClient(target);
  const channelUrl = normalizeChannelUrl(client ? client.channelUrl : target);
  if (!channelUrl) {
    console.error(`Not a YouTube channel: ${target}`);
    console.error('Pass a saved client name, an @handle, or a full channel URL.');
    process.exit(1);
  }

  const settings = {
    height: Number(flags.height) || client?.height || DEFAULT_HEIGHT,
    fps: Number(flags.fps) || client?.fps || DEFAULT_FPS,
    preferH264: client ? client.preferH264 !== false : true,
    minDurationSec: Number(flags['min-duration']) || client?.minDurationSec || 180,
    limit: Number(flags.limit) || 0,
    order: flags.oldest ? 'oldest' : 'newest',
  };
  // There is no H.264 above 1080p on YouTube — asking for it would cap the run at 1080.
  if (settings.height > 1080) settings.preferH264 = false;

  const listUrl = channelVideosUrl(channelUrl);
  console.log(`\nReading ${listUrl} ...`);

  const meta = await getChannelMetadata(listUrl);
  const channelTitle = meta.channel || meta.uploader || meta.title || '(unknown)';
  const channelKey = storage.makeChannelKey(meta);
  const all = await listChannelVideos(listUrl);
  const selected = selectLongForm(all, settings);

  const estimated = selected.reduce(
    (sum, v) => sum + estimateBytes(v.duration, settings.height, settings.fps), 0
  );
  const destDir = flags.dest
    ? path.resolve(String(flags.dest).replace(/^~(?=$|\/)/, process.env.HOME || '~'))
    : storage.downloadDir(channelKey);
  const free = await freeSpaceBytes(path.dirname(destDir));

  console.log(`
  Channel:    ${channelTitle}
  Long form:  ${selected.length} videos (of ${all.length} listed)
  Quality:    up to ${settings.height}p, preferring ${settings.fps}fps${settings.preferH264 ? ', H.264' : ''}
  Order:      ${settings.order} first${settings.limit ? `, first ${settings.limit} only` : ''}
  Destination:${destDir}
  Estimated:  ~${fmtGb(estimated)}${free !== null ? `   (free on disk: ${fmtGb(free)})` : ''}
`);

  if (selected.length === 0) {
    console.log('Nothing matched the long-form filter. Try lowering --min-duration.');
    process.exit(0);
  }

  const preview = selected.slice(0, flags['dry-run'] ? selected.length : 5);
  for (const [i, v] of preview.entries()) {
    console.log(`  ${String(i + 1).padStart(3)}. [${fmtDuration(v.duration)}] ${v.title || v.id}`);
  }
  if (!flags['dry-run'] && selected.length > preview.length) {
    console.log(`  ... and ${selected.length - preview.length} more`);
  }

  if (free !== null && estimated > free) {
    console.log(`\n  WARNING: the estimate is larger than the free space on that drive.`);
    console.log(`  Use --limit to pull them in batches, or --dest to point at a bigger drive.`);
  }

  if (flags['dry-run']) {
    console.log('\nDry run — nothing downloaded.');
    process.exit(0);
  }

  if (client && !client.verified) {
    console.log(`\n  "${client.key}" in clients.json is not verified yet — confirm this is the right channel.`);
  }

  if (!flags.yes && !(await confirm(`\nDownload ${selected.length} videos (~${fmtGb(estimated)})?`))) {
    console.log('Cancelled.');
    process.exit(0);
  }

  if (client && !client.verified) {
    markVerified(client.key, channelUrl);
    console.log(`Saved ${channelUrl} as verified for "${client.key}".`);
  }

  const jobId = await startDownloadJob({
    ...settings,
    channelUrl,
    label: client?.label || channelTitle,
    destDir: flags.dest ? destDir : null,
  });

  let stopping = false;
  process.on('SIGINT', () => {
    if (stopping) process.exit(130);
    stopping = true;
    console.log('\nStopping after the current video — press Ctrl-C again to force quit.');
    cancelJob(jobId);
  });

  // Single self-overwriting status line; pad to the previous width so shorter
  // lines don't leave the tail of the longer one behind.
  let lastLen = 0;
  const writeStatus = (line) => {
    process.stdout.write(`\r${line.padEnd(lastLen)}`);
    lastLen = line.length;
  };

  for (;;) {
    const job = getJob(jobId);
    if (!job) break;
    const p = job.progress;

    if (job.status === 'downloading' && p.currentTitle) {
      const index = Math.min(p.done + 1, p.total);
      writeStatus(
        `  [${index}/${p.total}] ${String(Math.round(p.percent)).padStart(3)}% ` +
        `${(p.speed || '').padEnd(10)} ETA ${(p.eta || '--:--').padEnd(6)} ` +
        `${p.currentTitle.slice(0, 50)}`
      );
    } else {
      writeStatus(`  ${job.status} ...`);
    }

    if (['done', 'cancelled', 'error'].includes(job.status)) {
      process.stdout.write('\n');
      if (job.warning) console.log(`\n  ${job.warning}`);
      if (job.error) {
        console.error(`\nFailed: ${job.error}`);
        process.exit(1);
      }
      console.log(`
  ${job.status === 'cancelled' ? 'Stopped' : 'Done'}: ${p.done - p.failed - p.skipped} downloaded, ${p.skipped} already had, ${p.failed} failed
  Folder:   ${job.destDir}
  Manifest: ${path.join(job.destDir, 'manifest.csv')}
`);
      if (p.failed) {
        console.log('  Re-run the same command to retry the failures — finished files are skipped.');
      }
      process.exit(0);
    }

    await sleep(400);
  }
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
