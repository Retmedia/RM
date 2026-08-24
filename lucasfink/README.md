# Lucas Fink: TikTok archive → Facebook Reels autopilot

Download every video @lucasfinkrj has posted to TikTok (1993 of them, ~23GB, no
watermark), then republish the whole catalog to his Facebook Page as Reels —
25 per day, oldest first, TikTok caption as the description, unattended for 80 days.

Runs on Garrett's Mac. Costs nothing: yt-dlp is open source, the Graph API has no
usage charges, launchd ships with macOS, Drive storage already exists.

## Files

| File | Goes to | Does |
|---|---|---|
| `download_lucasfink_tiktok.sh` | run in place | Downloads all 1993 videos |
| `lucas_caption_queue.csv` | `~/lucas_caption_queue.csv` | 1993 captions, translated, oldest first |
| `fb_publish_daily.py` | `~/fb_publish_daily.py` | Publishes 25/day |
| `install_fb_daily.sh` | run in place, once | Installs the launchd job |

The installer copies the middle two into `~` for you. You never move files by hand.

---

## Run it

### 1. Download

First check Google Drive for Desktop → Preferences: the RM Drive folder must be
**Mirror**, not Stream. On Stream the uploader has to re-fetch every video from
Google before posting it, every day for 80 days.

Open `download_lucasfink_tiktok.sh` and set `DEST=` (line 16) to the Lucas Fink
folder inside RM Drive. Then:

```bash
./download_lucasfink_tiktok.sh
```

3–5 hours. It self-installs yt-dlp into `~/.tiktok-dl-venv`, resumes if
interrupted (re-running costs nothing), and skips anything already on disk.

When yt-dlp finishes, Drive still has to push ~23GB up to Google. That is a
separate wait bounded by your upload speed. The folder is not "done" the moment
the script exits.

### 2. Get the Meta token

**The only step that needs your hands.** Facebook will not issue a token without
you logged in. Five minutes, free:

1. developers.facebook.com → My Apps → Create App → type **Business**
2. Tools → Graph API Explorer
3. Pick the app → **Get Token** → **Get Page Access Token** → the Lucas Fink page
4. Add permissions: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`
5. Paste the token into the Access Token Debugger → **Extend Access Token**
6. `echo 'THE_TOKEN' > ~/.fb_lucas_token && chmod 600 ~/.fb_lucas_token`

**Do the 3-minute upgrade instead if you can.** The token above expires in ~60
days and this run is 80, so it will die around day 60 and the job stops. Business
Settings → System Users → Add → assign the Page → Generate Token with those same
three permissions. Those never expire. Otherwise set a reminder for day 55.

The publisher checks token health on every run and shouts in the log from 14 days out.

### 3. Install the daily job

```bash
./install_fb_daily.sh "/path/to/RM Drive/Lucas Fink"
```

It validates the folder, patches `VIDEO_DIR`, installs the files, does a dry run,
and only installs the launchd job if the dry run passes. Daily at 9:15am.

### 4. Post three real ones and look at the Page

```bash
~/.tiktok-dl-venv/bin/python ~/fb_publish_daily.py --limit 3
```

Confirm on the Page that all three are actual Reels with the right caption. If
they are, the other 1990 will be too — it is the same three API calls every time.

### 5. Stop the Mac sleeping

```bash
sudo pmset -a sleep 0
```

launchd **skips** a missed run rather than queuing it, so every night the lid is
shut adds a day to the 80. This is the single most likely thing to stretch the run.

---

## Day to day

```bash
~/.tiktok-dl-venv/bin/python ~/fb_publish_daily.py --status   # progress
tail -f ~/fb_publish.log                                      # watch it work
launchctl kickstart gui/$(id -u)/com.retmedia.lucasfink.fbpublish   # run today now
launchctl bootout   gui/$(id -u)/com.retmedia.lucasfink.fbpublish   # stop for good
```

Bookkeeping lives in the video folder, not in `~`:

- `_fb_posted.csv` — every successful post, appended immediately after each one.
  This is the source of truth. Delete it and the job starts over from video 1.
- `_fb_skipped.csv` — videos that failed. After 3 attempts one is set aside so it
  cannot hold up the queue.
- `_fb_publish.lock` — stops a manual run and the 9:15 run posting the same video twice.
- `_archive.txt`, `_index.tsv` — the downloader's bookkeeping.

## How it behaves when things go wrong

| Situation | What happens |
|---|---|
| Meta rate-limits mid-run | Stops cleanly. Tomorrow resumes at exactly the next video. |
| Token expires or is revoked | Stops immediately, says so in the log. Nothing is lost. |
| A video file is missing | Logged, skipped, the day still posts its full 25. |
| One video fails 3 times | Set aside so it cannot block the other 1992. |
| Mac dies mid-post | State is appended after each post, so nothing double-posts. |
| Two runs overlap | The second one exits without posting. |
| Queue runs out | Says so and tells you to remove the launchd job. |

## Facts worth not re-deriving

**TikTok.** Profile enumeration by handle fails; the channel-ID form
(`tiktokuser:MS4wLjABAAAA...`) works. The format literally named `download` is the
**watermarked** one — `-f "b[format_id!=download]"` excludes it and yields clean
1080x1920 H.265. Do not change that selector. `yt-dlp[default,curl-cffi]` gives TLS
impersonation; without it TikTok intermittently refuses requests.

**Facebook.** Page ID `946028488753049`. Reels publishing is three calls: `start`
→ binary upload to the returned `rupload.facebook.com` URL → `finish` with
`video_state=PUBLISHED` and the description. Meta caps Reels at **30 per rolling
24 hours**; 25/day leaves headroom for retries — do not raise it. Reels max out at
**90 seconds**; 33 of the 1993 are longer (longest 5m43s) and route automatically
to `/videos` instead. Scheduling was deliberately not used — Meta lists a
`SCHEDULED` state but documents no parameter for the timestamp, so the daily
launchd job is the scheduler.

**Captions.** 735 translated from Portuguese, 1258 already-English passed through
byte for byte, hashtags and @mentions preserved exactly. 4 videos have no caption
on TikTok and post with an empty description.

**Filenames.** `%(title).72B [%(id)s].%(ext)s` — yt-dlp truncates titles to 72
chars anyway, and the publisher finds each file by the ID in brackets. Full
captions come from the CSV, never from the filename.

## Do not

- **Do not use SnapTik or a browser downloader.** 1993 videos one at a time, with
  server-side re-encoding. Already evaluated and rejected.
- **Do not use browser automation for the uploads.** Chrome's file upload path
  rejects files over 10MB and these average 12MB. The Graph API is 3 calls at any size.
- **Do not raise 25/day.** Meta's cap is 30.
- **Do not add a second state layer.** `_fb_posted.csv` already makes re-runs safe.

## The one risk no script can remove

Meta's originality and monetization rules for a back catalog republished from
TikTok have changed repeatedly. The watermark is gone, which is the usual
disqualifier, but if any part of this is a monetization play, Lucas should confirm
with his Meta partner contact before day 30.

---

## Tests

```bash
tests/run_all.sh
```

Runs the publisher against a mock Graph API — no network, no token, no real
posts. Covers the 3-call Reels flow (including the `offset` / `file_size` /
`OAuth` upload headers and `video_state=PUBLISHED`), the >90s route to `/videos`,
captions arriving byte for byte, resume without double-posting, rate-limit and
expired-token stops, missing files, a poison video being set aside, and the run lock.
