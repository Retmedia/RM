# Ekko

Archive a YouTube channel's full transcript catalog into a local vault you own.

Ekko runs entirely on your machine. It uses [yt-dlp] to pull captions, stores
each video's metadata as JSON and each transcript as VTT in a folder you
control, and exports a clean shareable ZIP whenever you want one.

[yt-dlp]: https://github.com/yt-dlp/yt-dlp

## Quick start

```bash
npm install
npm run install-ytdlp     # downloads bin/yt-dlp once
npm start                 # opens http://localhost:3939
```

On macOS you can also double-click `EkkoArchive.command`, which does the
above three steps in order and opens the browser.

## Where your data lives

Ekko writes to `<repo>/.archive-vault/` by default. Override with the
`EKKOARCHIVE_VAULT` env var:

```bash
EKKOARCHIVE_VAULT="$HOME/Documents/EkkoVault" npm start
```

Inside the vault each channel has its own directory:

```
<vault>/
  <channelKey>/
    channel.json              # channel metadata
    videos/<videoId>.json     # one file per video, atomically written
    transcripts/<videoId>.en.vtt
  _jobs/<jobId>.json          # job state, survives a restart
```

`<channelKey>` is `<slugified-title>-<last-8-chars-of-channel-id>`.

## Using the app

- **Home** — paste a channel URL, choose a subtitle language, optionally
  include Shorts (under 60s), click *Start archive*.
- **Status bar** — bottom of every view. Shows active jobs and the vault
  path. Click the pill to jump to Jobs.
- **Jobs** — live progress via SSE. Cancel running jobs. Resume jobs
  that were interrupted by a server restart (resuming just re-runs the
  same URL — already-pulled videos are skipped).
- **Channel** — click any channel in the sidebar. Search titles, filter
  by transcript status (OK / Unavailable), filter by duration
  (Long-form / Shorts), sort by date / duration / segment count.
- **Transcript viewer** — click a video row. `←/→` paginate through the
  current filtered list. `Esc` closes.
- **Export Vault** — top-right of any channel. Toggle SRT files. Optionally
  enter a customer name and preview the delivery email.

## Keyboard shortcuts

| Key      | Action                                  |
| -------- | --------------------------------------- |
| `/`      | Focus search on the current channel     |
| `Esc`    | Close any dialog                        |
| `← / →`  | Previous / next transcript in the viewer |
| `g h`    | Go to Home                              |
| `g j`    | Go to Jobs                              |
| `g s`    | Go to Settings                          |

## Vault delivery (export)

The export builds an in-memory ZIP — no shelling out, works on macOS,
Windows, and Linux:

```
{ChannelName}_EkkoVault_{YYYY-MM-DD}.zip
└── {ChannelName}_EkkoVault_{YYYY-MM-DD}/
    ├── README.md             # what's inside, how to use it
    ├── COMBINED_MASTER.md    # every transcript, newest first
    ├── INDEX.csv             # titles, URLs, dates, view counts, word counts
    ├── individual_transcripts/
    │   └── {videoId}_{slugified_title}.md
    └── srt_files/            # only if you opted in
        └── {videoId}_{slugified_title}.srt
```

Channel name is PascalCase (`Jack Neel` → `JackNeel`, `@MrBeast` →
`MrBeast`, non-Latin falls back to the handle). Date is ISO in your local
timezone. Title slugs preserve a leading `#` (so `#1 Divorce Lawyer…`
becomes `_1_divorce_lawyer…`) and collide-resolve via a SHA-1 short hash.

## Delivery email (optional)

Render the delivery email template without sending anything:

```bash
curl "http://localhost:3939/api/channels/<channelKey>/delivery-email?customerName=Jamie&downloadUrl=https://your.host/file.zip"
```

Returns `{ subject, body }` as JSON. Edit `server/templates/delivery-email.md`
to change the copy.

## API

| Method | Path                                                         | Notes                                       |
| ------ | ------------------------------------------------------------ | ------------------------------------------- |
| GET    | `/api/health`                                                | `{ ok, vault }`                             |
| GET    | `/api/channels`                                              | List archived channels                      |
| GET    | `/api/channels/:key/videos`                                  | List video metadata, newest first           |
| GET    | `/api/channels/:key/videos/:videoId/transcript`              | Parsed segments for the viewer              |
| GET    | `/api/channels/:key/export?individual=1&srt=0`               | Streams the ZIP as `application/zip`        |
| GET    | `/api/channels/:key/delivery-email?customerName=&downloadUrl=` | Renders the email template                |
| POST   | `/api/jobs`                                                  | `{ channelUrl, includeShorts?, language? }` |
| GET    | `/api/jobs`                                                  | List all jobs                               |
| GET    | `/api/jobs/stream`                                           | Server-Sent Events                          |
| POST   | `/api/jobs/:id/cancel`                                       | Flip abort on the running job               |
| POST   | `/api/reveal-vault`                                          | Open the vault folder in the OS file manager |

## Tests

```bash
npm test
```

Uses Node's built-in `node:test` runner. The suite covers the slugifier,
word-count rounding boundaries, the ZIP writer (round-trip + UTF-8
filenames + spec-vector CRC-32 checks), and the end-to-end vault
exporter against a fixture channel on a tmp disk.

## Troubleshooting

- **"yt-dlp not found"** — run `npm run install-ytdlp` to drop the
  binary into `bin/`. Override with `YTDLP_BIN=/path/to/yt-dlp` if
  you've installed it system-wide.
- **No transcript pulled** — YouTube may not expose captions for that
  video. Errors are logged on the video record under `transcript_reason`.
- **Job stuck on "interrupted"** — server died mid-archive. Open Jobs
  and click Resume; already-pulled videos are skipped.

## Status

This pass focused on UX, the export pipeline, and the most useful
correctness wins. See `AUDIT.md` for items deliberately deferred (cross-
channel search, ⌘K, ETA, etc.).
