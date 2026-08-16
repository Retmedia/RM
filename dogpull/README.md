# DogPull

Pulls a YouTube channel's long-form catalogue down to the RM drive in 4K,
named after the videos themselves, and never downloads the same video twice.

Currently pointed at **Xander Budnick — up to 2160p (4K), 30 fps**.

DogPull is standalone. It is not part of Echo, shares nothing with it, and has
no npm dependencies — just Node and two binaries.

---

## First-time setup

```bash
cd dogpull
npm run setup        # fetches yt-dlp into dogpull/bin
brew install ffmpeg  # required — see below
```

**ffmpeg is not optional.** YouTube sends 4K as separate video and audio
streams; yt-dlp needs ffmpeg to merge them back together. Without it you
quietly get a lower-quality single-file version instead of the 4K you asked
for. DogPull refuses to start rather than let that happen.

---

## Running it

```bash
npm run dry-run      # show exactly what would download — downloads nothing
npm run pull         # pull everything not already on the drive
```

Or double-click **DogPull.command** in Finder.

Always start with `npm run dry-run`. It prints the channel, how many long-form
videos exist, how many you already have, how much is left, and the estimated
size — before anything touches the disk.

Sensible first real run:

```bash
node dogpull.js --limit 3      # prove it end to end on three videos
node dogpull.js                # then let it finish the channel
```

### Options

| Flag               | What it does                                          |
| ------------------ | ----------------------------------------------------- |
| `--dry-run`        | show the plan, download nothing                        |
| `--limit N`        | only the first N new videos                            |
| `--oldest`         | start from the oldest upload (default: newest first)   |
| `--jobs N`         | videos at once (default 2)                             |
| `--height N`       | max height, e.g. `2160`, `1080`                        |
| `--fps N`          | preferred frame rate, e.g. `30`, `60`                  |
| `--min-duration S` | anything shorter counts as a Short (default 180)       |
| `--dest PATH`      | pull to another drive                                  |
| `--refresh`        | re-list the channel instead of using the cached list   |
| `--retry-failed`   | retry videos that failed before                        |
| `--yes`            | skip the confirmation prompt                           |

---

## Where it lands

```
RM/DogPull/Xander Budnick/
    Solo Survival- 7 Days in the Bush.mp4
    Catch & Cook- Wild Trout - River Camp.mp4
    DogPull Manifest.csv
    .dogpull/              ← memory of what's been pulled
```

Files are named after the video title. Characters macOS can't put in a filename
(`/` and `:`) become `-`; the manifest keeps the real title. If two videos share
a title, the second becomes `Title (2).mp4`.

`DogPull Manifest.csv` opens in Sheets: filename, real title, video ID, upload
date, duration, and the resolution/fps/codec **actually received** — so you can
confirm you really got 4K rather than assuming.

Change the destination in `config.json` (`destination`), or per-run with
`--dest /Volumes/YourDrive/Xander`.

---

## Never downloading twice

DogPull keeps a ledger in `.dogpull/ledger.json`, keyed by YouTube video ID —
not filename, so a video that gets retitled is still recognised as one you have.

Before each run it checks that ledger *and* that the file is still on disk:

- already have it → skipped, with no network call at all
- file deleted → downloaded again
- previously failed → retried only with `--retry-failed`
- new upload → downloaded

Re-running is always safe, and the ledger lives beside the footage, so moving
the drive moves the memory with it.

## Stopping and resuming

Ctrl-C finishes the downloads in flight, then stops. Part-downloaded files
resume where they left off on the next run.

---

## Speed

- 8 fragments per video in parallel, 2 videos at a time (`--jobs` to change)
- videos you already have are filtered out locally, before any network call
- the channel listing is cached for 6 hours, so repeat runs start immediately
  (`--refresh` to force a fresh list)
- throttled streams are automatically re-requested rather than crawling

The real limit is your connection and the drive. 4K runs roughly 2 GB per
20-minute video, so a full catalogue is a large download — DogPull estimates
the total up front and warns if it won't fit on the target drive.

---

## Quality

`up to 2160p, preferring 30fps`. YouTube only has what the channel uploaded: if
an older video was never posted above 1080p, no tool can invent 4K — DogPull
takes the best available and records what it actually got in the manifest.

At 4K, video is VP9 (there is no H.264 above 1080p on YouTube) and audio is AAC
where offered, which keeps the files friendly to CapCut, Premiere and Resolve.

## Pointing it at another channel

Edit `config.json` — `channel`, `label`, `folderName`, `height`, `fps`. Shorts
and live streams are always excluded.
