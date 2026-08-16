# EkkoArchive (Echo)

Pull a YouTube channel into a local vault — transcripts, metadata, and now the
**source video files in bulk**.

Use it on channels you own or manage. Everything runs locally on your machine.

---

## One-time setup

```bash
cd ekkoarchive
npm install
npm run install-ytdlp     # downloads the yt-dlp binary into bin/
brew install ffmpeg       # REQUIRED — see below
```

**ffmpeg is not optional.** YouTube serves 1080p and 4K as *separate* video and
audio streams. yt-dlp needs ffmpeg to merge them back together. Without it you
silently get a lower-quality single-file version instead of the quality you
asked for. EkkoArchive checks for it and refuses to start a download rather than
letting you find out after 80 videos.

---

## Bulk downloading

Two clients are pre-saved with their preferred quality:

| Preset  | Channel        | Quality              |
| ------- | -------------- | -------------------- |
| `xander`| Xander Budnick | 4K (2160p), 30 fps   |
| `blair` | Blair Conklin  | 1080p, 60 fps, H.264 |

```bash
# See what would download — lists every video and the total size. Downloads nothing.
npm run download -- xander --dry-run

# Test with the 3 most recent before committing to the whole catalog
npm run download -- xander --limit 3

# The whole channel
npm run download -- xander

# Any other channel
npm run download -- @somehandle --height 1080 --fps 60
```

Every run prints the channel it resolved, the video count and a size estimate,
then waits for a `y` before downloading anything.

### Options

| Flag               | Meaning                                              |
| ------------------ | ---------------------------------------------------- |
| `--limit N`        | only the first N videos — good for a test batch       |
| `--oldest`         | start from the oldest upload (default: newest first)  |
| `--height N`       | max height: `2160`, `1440`, `1080`, `720`             |
| `--fps N`          | preferred frame rate: `60` or `30`                    |
| `--min-duration S` | anything shorter counts as a Short (default `180`)    |
| `--dest PATH`      | save somewhere else, e.g. an external drive           |
| `--dry-run`        | list what would download, then stop                   |
| `--yes`            | skip the confirmation prompt                          |

### Long form only

Shorts and live streams are excluded automatically. Two things make that
reliable: the channel's `/videos` tab already excludes Shorts, and anything
under 3 minutes is filtered out as a backstop (YouTube now allows Shorts up to
3 minutes). Lower it with `--min-duration` if a client posts short real videos.

### Where files land

```
.archive-vault/<channel>/downloads/
    2025-01-14 - Video Title [dQw4w9WgXcQ].mp4
    2025-02-28 - Another Video [abc123XYZ_9].mp4
    manifest.csv
```

Filenames are date-prefixed so they sort chronologically in Finder. The video ID
in brackets is what lets a re-run know what it already has.

`manifest.csv` opens in Sheets and lists every file with its title, upload date,
duration, **actual** height/fps/codec received, and size — so you can confirm you
really got 1080p60 rather than assuming.

### Stopping and resuming

Ctrl-C stops after the current video. Re-running the same command skips
everything already downloaded, retries anything that failed, and picks up new
uploads. It is always safe to re-run.

If a file is deleted from the downloads folder, the next run fetches it again.

### Disk space

4K is big — roughly 2 GB per 20-minute video, versus about 500 MB at 1080p60.
A full 4K catalog can easily run into hundreds of gigabytes. The tool estimates
the total before starting and warns if it exceeds the free space on the target
drive. Use `--limit` to work in batches, or `--dest` to target an external drive.

---

## Web UI

```bash
npm start          # or double-click EkkoArchive.command on a Mac
```

Opens at http://localhost:3939 with the same functionality: archive transcripts,
start downloads, watch live progress, and browse the vault. The vault table shows
which videos have a transcript, a video file, or both.

---

## A note on OpusClip

OpusClip accepts a YouTube URL directly, so for straightforward
long-form-to-shorts clipping you don't need to download anything first.

Downloading locally is worth it when you want:

- the **full-quality master** to edit in CapCut/Premiere rather than OpusClip's re-encode
- an **archive** that survives a video being taken down or a channel changing hands
- footage OpusClip can't reach, or B-roll to reuse across posts
- source files paired with Echo's transcripts, so you can find a moment in the
  transcript and cut straight to that timestamp

A practical split: OpusClip for fast volume clipping off the URL, local downloads
for anything you're editing by hand or want to keep.
