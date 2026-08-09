# EkkoArchive

Pull a YouTube channel's videos and transcripts into a local, searchable vault.
Runs entirely on your machine — a small Express server drives
[`yt-dlp`](https://github.com/yt-dlp/yt-dlp) and stores everything as plain JSON
and text files.

## Run

**macOS:** double-click `EkkoArchive.command`. It installs dependencies and the
`yt-dlp` binary on first launch, then opens the UI.

**Manually:**

```bash
npm install
npm run install-ytdlp   # downloads the yt-dlp binary into ./bin
npm start               # http://localhost:3939
```

Requires Node.js >= 18.

## How it works

1. Enter a channel URL and start a job.
2. EkkoArchive fetches channel metadata, lists the videos, and pulls the
   transcript (subtitles) for each one, **several at a time**.
3. Results land in the vault: channel + per-video metadata as JSON, plus the raw
   `.vtt` and a cleaned-up plaintext `.txt` transcript per video.

Videos already archived with a transcript are skipped on re-runs, so archiving a
channel again only fetches what's new.

## Configuration

| Variable                  | Default             | Description                                              |
| ------------------------- | ------------------- | -------------------------------------------------------- |
| `PORT`                    | `3939`              | HTTP port for the local UI/API.                          |
| `EKKOARCHIVE_VAULT`       | `./.archive-vault`  | Where channels, metadata, and transcripts are stored.    |
| `EKKOARCHIVE_CONCURRENCY` | `3`                 | How many transcripts to pull at once (1–8).              |

Concurrency can also be set per job in the `POST /api/jobs` body. Requests are
jittered to stay gentle on YouTube; raise concurrency cautiously.

## Vault layout

```
.archive-vault/
  <channel-key>/
    channel.json
    videos/<videoId>.json
    transcripts/<videoId>.vtt
    transcripts/<videoId>.txt
```

## API

| Method | Path                                              | Description                          |
| ------ | ------------------------------------------------- | ------------------------------------ |
| GET    | `/api/health`                                     | Server + vault status.               |
| GET    | `/api/channels`                                   | Archived channels.                   |
| GET    | `/api/channels/:key/videos`                       | Videos for a channel.                |
| GET    | `/api/channels/:key/videos/:id/transcript`        | Plaintext transcript for a video.    |
| POST   | `/api/jobs`                                        | Start an archive job.                |
| GET    | `/api/jobs` · `/api/jobs/:id`                      | List / inspect jobs.                 |
| POST   | `/api/jobs/:id/cancel`                             | Cancel a running job (kills `yt-dlp`).|
