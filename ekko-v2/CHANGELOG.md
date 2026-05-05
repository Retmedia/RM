# Changelog

## Unreleased — audit & improvement pass + vault delivery polish

### Added

- Dark + violet UI shell with sidebar nav (Home / Jobs / Settings) and a
  persistent bottom status bar showing active jobs from anywhere in the app.
- Toast notification system; replaces every `alert()`. Error toasts get a
  Copy button.
- Modal system with a transcript viewer that supports `←/→` prev/next
  pagination through the current channel's filtered video list.
- Channel detail toolbar: in-channel search, transcript-status filter,
  duration filter (Long ≥60s / Short <60s), sortable columns.
- Empty states for Home, Jobs, channel-with-zero-videos, and no-results
  search.
- Settings view exposing the vault path with Copy and Reveal-in-finder
  buttons, plus a printed keyboard-shortcuts table.
- Keyboard shortcuts: `/` focuses search, `Esc` closes dialogs, `←/→`
  paginate transcripts, `g h` / `g j` / `g s` go-to chord.
- SSE endpoint `GET /api/jobs/stream` — live job updates pushed to the
  client. Replaces 2.5s polling.
- Job persistence: every state change writes
  `<vault>/_jobs/<id>.json`. On restart, in-progress jobs are flipped to
  `interrupted` so the Jobs view can offer Resume.
- yt-dlp retry: 3-attempt exponential backoff (500ms → 2s → 5s) for
  transient errors. Permanent reasons (no captions, private, age-gate,
  members-only) skip retries.
- Vault export: `GET /api/channels/:key/export?individual=&srt=` builds a
  pure-Node ZIP with the structure
  `{ChannelName}_EkkoVault_{YYYY-MM-DD}/{README.md, COMBINED_MASTER.md,
  INDEX.csv, individual_transcripts/, srt_files/}`.
- Delivery email template `server/templates/delivery-email.md` and render
  endpoint `GET /api/channels/:key/delivery-email`. Falls back to
  "Hi there," if `customerName` is omitted; never emits `[Name]`.
- `POST /api/reveal-vault` opens the vault folder in Finder / Explorer /
  xdg-open.
- `GET /api/channels/:key/videos/:videoId/transcript` — segments JSON for
  the in-app viewer.
- 25 tests using Node's built-in `node:test` runner. `npm test`.

### Changed

- Storage hides `_`-prefixed directories (e.g. `_jobs`) from
  `listChannels()`.
- `formatWordCount` rounds with `Math.round(m*10)/10` so `2,150,000`
  becomes `"2.2 million"` instead of falling into a `toFixed(1)` corner.

### Notes

- No new npm dependencies. The ZIP writer is hand-rolled in
  `server/zip.js` against the standard ZIP format using built-in `zlib`.
- Frontend is still vanilla JS, no build step.
- See `AUDIT.md` for the full audit and the items deliberately deferred.
