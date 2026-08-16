# DogPull

Pulls a YouTube channel's long-form catalogue down to the RM drive,
named after the videos themselves, and never downloads the same video twice.

Currently pointed at **Xander Budnick — best available up to 4K, 30 fps**
(`https://www.youtube.com/@XanderBudnick`).

DogPull is standalone. It is not part of Echo, shares nothing with it, and has
no npm dependencies — just Node and two binaries.

---

## First-time setup

```bash
cd dogpull
npm run setup        # fetches yt-dlp into dogpull/bin
brew install ffmpeg  # required — see below
```

**ffmpeg is not optional.** YouTube sends 1080p and above as separate video and
audio streams; yt-dlp needs ffmpeg to merge them back together. Without it you
quietly get a lower-quality single-file version instead of the quality you asked
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
| `--height N`       | max height, e.g. `1080`, `2160`                        |
| `--fps N`          | preferred frame rate, e.g. `30`, `60`                  |
| `--min-duration S` | anything shorter counts as a Short (default 180)       |
| `--dest PATH`      | pull to another drive                                  |
| `--refresh`        | re-list the channel instead of using the cached list   |
| `--no-probe`       | skip the source-quality check (faster, rougher size)   |
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

The real limit is your connection and the drive. DogPull samples the catalogue
before each run to estimate the total, and warns if it won't fit.

---

## Quality

The ceiling is **best available, up to 4K** — not a fixed size. Each video comes
down at the best it was ever uploaded in: 4K where that exists, 1080p where
that's all there is. Asking for 4K costs nothing extra on a video that was only
posted at 1080p.

**Why not just take 1080p?** Because shorts are cropped 9:16 out of 16:9 source.
Cropping a vertical slice from 1080p leaves about 608px of width, which then has
to be upscaled ~1.8× to fill a 1080×1920 short — visibly soft. From 4K the same
crop is ~1215px wide and gets *downscaled*, which stays sharp and leaves room to
punch in or reframe. For a pipeline built on vertical clips, source resolution
is the one thing you can't add back later.

### The source check

Every run samples a spread of videos — newest, middle and oldest, since upload
quality changes over a channel's life — and reports what's really there:

```
  Source check: 12 sampled — 9 at 4K, 1 at 1440p, 2 at 1080p
  Estimated:    ~48 GB (measured from sampled videos)
```

That estimate comes from the real stream sizes YouTube reports, not a bitrate
table, so it's a measurement rather than a guess. It's cached for a week and
skippable with `--no-probe`.

### Dialling it down

If the estimate is bigger than you want:

| Setting          | Effect                                            |
| ---------------- | ------------------------------------------------- |
| `--height 1440`  | roughly half the size, still sharper than 1080p    |
| `--height 1080`  | smallest; fine for 16:9 midforms, soft for shorts  |

Codec follows the resolution automatically: VP9 above 1080p (H.264 doesn't exist
up there on YouTube) and H.264 at 1080p, always with AAC audio — the combination
CapCut, Premiere and Resolve handle most smoothly.

The manifest records the resolution, frame rate and codec **actually received**
for every file, so you can confirm rather than assume.

## Pointing it at another channel

Edit `config.json` — `channel`, `label`, `folderName`, `height`, `fps`. Shorts
and live streams are always excluded.
