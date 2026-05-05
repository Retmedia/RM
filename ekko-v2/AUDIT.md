# Ekko audit & improvement pass

## Important context

The audit prompt described `~/Documents/Ekko/ekko-app/` on a Mac with
~840-line `server/server.js`, `transcript-puller.js`, `parse-transcript.js`,
`migrations.js`, `progress.js`, `tests/`, `youtubei.js`, ZIP export, SSE
jobs, trash UI, settings page, etc. This Linux sandbox has no access to
that filesystem. The codebase available here is `/home/user/RM/ekkoarchive/`,
a 13-file scaffold (single commit, "Scaffold ekkoarchive: standalone YouTube
channel archiver"). The Mac codebase wasn't pushed to the repo.

Rather than fabricate findings against a codebase I couldn't see, I built
a working product on top of the scaffold that maps onto the prompt's
intent. This document is a) what the scaffold actually had, b) what I built
on top of it, c) which Phase-2 items don't apply because they describe code
paths that don't exist here, and d) what I deliberately deferred.

## What the scaffold had (baseline)

- Express, single-process job runner, vault on disk (per-video JSON files
  written via atomic rename). No SSE, no persistence — jobs lived in memory.
- yt-dlp wrapper for channel listing and transcript pull. Sub-format VTT,
  in-process VTT parser with repeat collapsing.
- One frontend page: archive form + 2.5s polling for jobs and channels.
  Light theme, blue accent, `alert()` for errors, `<table>` of videos with
  no filtering, no search, no transcript viewer.
- `slugify()` for channel directory names. No PascalCase, no per-video
  slug, no word-count formatting, no ZIP exporter.
- No tests. No `npm test` script.

## Phase-2 items that don't apply

| Phase-2 concern                                               | Status here                                                                                                  |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `runBulkPull` race when concurrency > 1                       | No bulk-pull function. Job loop is strictly sequential with a 750ms sleep. No race surface.                  |
| Per-video update rewrites the whole channel JSON              | Already per-video files (`storage.js:saveVideo`). No big channel JSON to rewrite.                            |
| `withYt()` / youtubei.js session-reset regex                  | youtubei.js is not a dependency. No `withYt`.                                                                |
| `_listChannelVideos` walks Videos+Shorts+LiveStreams without filter | `listChannelVideos` already filters live and applies a 60s threshold for shorts unless includeShorts is set. |
| ZIP shells out to system `zip`                                | There was no ZIP exporter at all.                                                                            |

These are noted up-front so we don't claim "fixed!" for code paths that
never existed in this branch.

## What I built (on `claude/improve-ekko-ux-afXlg`)

### Frontend

- Dark + violet shell with sidebar (Home / Jobs / Settings / channel list),
  persistent bottom status bar, hash-based router.
- Toast system with copy-error action; replaces every `alert()`.
- Modal system; transcript viewer with `←/→` prev-next inside the modal.
- Channel detail toolbar: in-channel search, filter by transcript status,
  filter by duration (Long ≥60s vs Short <60s), sortable columns
  (date / duration / segment count) with arrow indicators.
- Empty states everywhere (home, jobs, channel, no-results).
- Keyboard shortcuts: `/` focuses search, `Esc` closes dialogs, `←/→`
  paginate transcripts inside the viewer, `g h` / `g j` / `g s` go-to
  chord for Home/Jobs/Settings.
- Settings view exposing the vault path with copy + reveal-in-finder
  buttons and a printed shortcut reference.

### Server / correctness

- SSE: `GET /api/jobs/stream` pushes the full jobs list on every state
  change. Replaces 2.5s polling.
- Job persistence: every state transition writes
  `<vault>/_jobs/<id>.json` via `writeJSONAtomic`. On startup,
  `loadPersistedJobs()` rehydrates and flips any in-progress job to
  `interrupted` so the UI can offer Resume.
- yt-dlp retry: 3-attempt backoff (500ms / 2s / 5s) for transient errors;
  short-circuits on `no captions`, `subtitles disabled`, `private video`,
  `members-only`, age-gate, etc.
- New endpoints: `GET .../videos/:id/transcript` for the viewer,
  `GET .../export` for the vault ZIP, `GET .../delivery-email` for the
  template render, `POST /api/reveal-vault` for the Settings button.

### Phase 5 — vault delivery polish

- Pure-Node ZIP writer (`server/zip.js`, ~150 LOC). Built using
  `zlib.deflateRawSync` + a hand-rolled CRC-32; supports STORE and
  DEFLATE, UTF-8 filenames, directory entries. No new npm dependency.
- ZIP layout exactly per the spec:

  ```
  {ChannelName}_EkkoVault_{YYYY-MM-DD}.zip
  └── {ChannelName}_EkkoVault_{YYYY-MM-DD}/
      ├── README.md
      ├── COMBINED_MASTER.md
      ├── INDEX.csv
      ├── individual_transcripts/
      │   └── {videoId}_{slugified_title}.md
      └── srt_files/                  (only if user opts in)
          └── {videoId}_{slugified_title}.srt
  ```

- `pascalCaseChannelName` strips `@`, non-alphanumerics, falls back to
  the handle when the name is non-Latin or empty.
- `slugifyTitle` lowercases, replaces non-alphanumerics with `_`, collapses
  repeats, preserves a leading `#` as `_`, trims to 60. Collisions resolved
  by appending the first 6 hex of a SHA-1 of the video id.
- `formatWordCount` per spec — exact under 10k, nearest 1k under 1M, one
  decimal "million" beyond. Uses `Math.round(m*10)/10` rather than
  `toFixed(1)` so 2,150,000 actually rounds to "2.2 million" instead of
  hitting the IEEE-754 corner.
- `localISODate` uses `getFullYear/getMonth/getDate`, not UTC.
- COMBINED_MASTER.md prepends the required header (Generated date, Total
  Videos, Total Words, Ctrl+F hint). Order is newest-first (verified by
  test).
- README.md inside the ZIP is exactly the spec template — does NOT
  include "Professionally cleaned", "90-Day Free Re-Archive", or "Reply
  to this delivery email" copy.
- `server/templates/delivery-email.md` separate file, rendered by
  `GET /api/channels/:key/delivery-email?customerName=&downloadUrl=`.
  Falls back to "Hi there," when `customerName` is omitted; never emits
  literal `[Name]`. Endpoint does not send mail.

### Tests

- Node's built-in `node:test` runner; no framework dependency.
- 25 tests covering slugifier edge cases (emoji, "#1", non-Latin, all-caps,
  >100-char titles), word-count rounding boundaries, CRC-32 spec vectors,
  ZIP round-trip with STORE + DEFLATE, UTF-8 filename preservation, and
  end-to-end `buildVaultZip` against a 3-video fixture written to a tmp
  vault. All green.

## Known limitations / what I deliberately deferred

| Item                                              | Why                                                                                                            |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| ⌘K command palette                                | Significant code for marginal value over `/` search and click. Defer.                                          |
| j/k video-list navigation                         | Defer — `←/→` inside the viewer covers the main ergonomic win.                                                 |
| Cross-channel transcript full-text search         | Naive scan re-reads every VTT on every keystroke. Worth a real index, not a stopgap. Defer.                    |
| Trash UI                                          | No delete flow exists yet — nothing to trash.                                                                  |
| ETA on bulk pull                                  | Real, but not load-bearing. Defer.                                                                             |
| Skeleton screens                                  | Spinners + good empty states are sufficient for the data shapes here. Defer.                                   |
| `migrations.js` + `CURRENT_VERSION`               | The schema here is small and v0; per-video files are easy to migrate in place when needed. No migrations yet.  |
| Cancellable in-flight `yt-dlp` mid-video          | `cancelJob` flips the abort flag; the current iteration finishes (≤3min timeout) before the loop exits. Acceptable. |

## Manual test checklist (what you should poke before merging)

- [ ] Start the server: `npm start`. Vault path printed to console.
- [ ] Visit `http://localhost:3939` — sidebar renders, status bar pill says "Idle".
- [ ] Paste a small YouTube channel URL. Job appears in status bar; SSE
      pushes live progress without a page refresh.
- [ ] Kill the server mid-archive. Restart it. Job appears under Jobs as
      "interrupted" with a Resume button.
- [ ] Open a channel that has at least one transcript. Click a video row —
      transcript modal opens, `←/→` paginate, `Esc` closes.
- [ ] Channel toolbar: `/` focuses search; type a query; clear; flip
      status filter; flip duration filter; click date/duration/segments
      column headers to toggle sort.
- [ ] Settings: Vault path shown, Copy works, "Reveal in file manager"
      opens Finder/Explorer.
- [ ] Click "Export Vault" on a channel. Toggle SRT off + on. Click
      "Preview email" — modal renders subject + body; Copy puts it on
      the clipboard.
- [ ] Click "Download Vault". Unzip on macOS Finder; verify the directory
      structure matches the layout above and that COMBINED_MASTER.md
      starts with the required header. (Not tested on Windows in this
      sandbox — please confirm on Windows Explorer.)
