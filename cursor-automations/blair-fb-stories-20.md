# Blair Conklin Facebook Stories (20/day)

**Status:** RECIPE ONLY as of 2026-09-25. Not Created in Cursor Mine.
**Owner:** Cursor Mine timer. Garrett Creates it.
**Page:** https://www.facebook.com/BlairConklin/
**Page ID:** not in this repo. The publisher reads `BLAIR_FB_PAGE_ID` from the environment. Blocked until Garrett's Page token and numeric Page ID are on the machine, not in git.
**Failure:** Email Garrett at info@retmediaagency.com.
**Timezone:** America/Los_Angeles.

Mine Create is required. This markdown is the spec. Do **not** add a new Grok routine. Do **not** store the Page token, Page ID, or a session file in this repo.

This is a Graph-archive style republish of existing Page videos into Stories. It is separate from Metricool live queues.

## Goal

Post **20 Facebook Stories a day** from Blair's existing Facebook Page posts. Oldest first, starting **2026-01-01 00:00 America/Los_Angeles**. Facebook only. Stories only. Do not raise the daily cap.

## Source

Read `GET /v26.0/{page-id}/feed` (Page Feed reference). Keep a post only when all of these are true:

- `is_published` is true
- `status_type` is `added_video`
- an attachment type is `video` or `video_autoplay`, or `media_type` is `video`
- `created_time` is on or after 2026-01-01 00:00 America/Los_Angeles
- the attachment URL path is not `/reel/`, `/reels/`, or `/stories/`

Request the fields the Page Feed reference lists (`created_time`, `is_published`, `status_type`, `attachments`, including `target.id`). Use Graph field expansion. Page through `paging.next` on `graph.facebook.com` only. `limit` stays at 100 (the feed reference maximum).

Time windows use `since` and `until` of at most 183 days. The pagination guide recommends a maximum of 6 months for consistent time paging.

Views come from `GET /{video-id}/video_insights?metric=total_video_views`. Keep a lifetime value of **10,000 or more**. Meta's insights guide (updated 2024-07-19, example on v20.0) describes that metric as the lifetime count of views of 3 seconds, or to the end, whichever came first. This job calls **v26.0**. If v26 rejects that metric, stop and email Garrett. Do not swap in another metric.

The video node fields used for the file are the ones on the Video reference fetched with this recipe: `source`, `format` (`width`, `height`), `created_time`. That reference did not list a `length` or `views` field. Duration is read from the downloaded MP4. Views are the insight above.

Sort eligible videos by post `created_time`, oldest first. Skip source video ids already in the ledger.

### Feed limit (honest)

The Page Feed reference says the API returns approximately **600 ranked, published posts per year**, and that `limit` cannot exceed 100. If Graph does not return the oldest 2026 posts, this job posts the oldest eligible videos it did receive, emails Garrett that the walk was short, and stops paging. It does not scrape the Page.

## Destination

Stories only. The only publish calls are the video story steps below. Do not also publish a feed post or a Reel. Do not call `/{page-id}/videos`, `/{page-id}/video_reels`, or `/{page-id}/photo_stories`.

Meta's Page Stories doc (https://developers.facebook.com/docs/page-stories-api/, last updated 2026-07-30, examples on v26.0):

1. `POST /{page-id}/video_stories` with `upload_phase` = `start`. Response: `video_id`, `upload_url`.
2. `POST` the file bytes to that `upload_url`. The host must be `rupload.facebook.com`. Headers: `offset` = `0`, `file_size` = byte length. Send the Page token as the `access_token` parameter (the same doc says that parameter is allowed). The doc's curl does not show an `Authorization` header, so this job does not invent one.
3. `POST /{page-id}/video_stories` with `video_id` and `upload_phase` = `finish`. Success returns `post_id`.

Download the video `source` URL and upload that local file. Do not pass a Facebook CDN url as `file_url`. The stories doc says files hosted on Meta CDN are rejected.

The local HTTP client sets `Content-Type: application/octet-stream` on that binary upload so the body is not treated as a form.

## Length and shape

From that same stories doc:

- Spec table, Duration: **3 to 90 seconds.** The same cell says a reel published as a story cannot exceed 60 seconds.
- Limitations: **a video story cannot exceed 60 seconds.**
- Limitations: a photo or video uploaded for a story cannot have been used in a previously published post.
- Spec table: file type `.mp4` (recommended), aspect **9 x 16**, resolution minimum **540 x 960** (1080 x 1920 recommended), frame rate 24 to 60.

This job skips a source video when the MP4 duration is under 3 seconds or over **60 seconds**. It does not trim. It does not treat the 90-second table line as permission to post a longer story. It also skips a video whose largest `format` is under 540 x 960 or is not 9 x 16. It does not crop. A local guard skips a download over 1 GB so a long file does not fill the disk.

If Meta rejects an upload because the media was already used in a published post, **stop and email Garrett.** Do not fall back to a feed post or a Reel. Republishing an existing Page video may fail for that documented reason. That is a Garrett decision before anyone treats this as a reliable daily lane.

## Schedule

- One Cursor Mine run per calendar day, America/Los_Angeles. Spec clock: **9:00am PT.**
- Cap is **20 successful story publishes per Pacific Time day**, including reruns. Do not run a second wave that would pass 20.
- Ledger path: `BLAIR_FB_STORIES_LEDGER`, or `~/.config/retmedia/blair-fb-stories-ledger.json` when that is unset. The ledger stores source video ids and story post ids. It must stay outside the repo.
- Stop on token, permission, rate limit, policy block, or Graph downtime. Documented codes used for that stop: token 102 and 190 (auth subcodes 458, 459, 460, 463, 464); throttle 4, 17, and 341; permission 10 and 200-299; policy 368; downtime 1 and 2; duplicate 506; HTTP 429. Email Garrett and stop. Do not retry inside the run.

## Before the first live post

1. Create this automation in Cursor Mine. This file is not live until then.
2. Put the numeric Page ID and Page token on the machine: `BLAIR_FB_PAGE_ID` and `BLAIR_FB_PAGE_TOKEN`, or `BLAIR_FB_PAGE_TOKEN_FILE` pointing outside the repo. Do not commit them. The public page URL is not a Page ID.
3. Confirm the `video_stories` upload against Meta's docs before the first live post. The publisher follows the 2026-07-30 doc. The rupload curl on that page does not show an Authorization header.
4. Run `blair_fb_stories.py --dry-run` once and read the skip counts before any live post.

Publisher: [`blair_fb_stories.py`](blair_fb_stories.py). Tests, mock HTTP only: [`test_blair_fb_stories.py`](test_blair_fb_stories.py).

## Runbook

1. Confirm the Mine automation is **Created** and the Page token plus numeric Page ID are on the machine, outside git.
2. At 9:00am PT, read the Page feed from 2026-01-01 PT forward, oldest first.
3. Publish up to 20 Stories that pass the source, view, length, and shape rules, skipping ids already in the ledger.
4. Stop at 20, or when eligible videos run out, or when token / rate limit / the already-published rejection hits.
5. On a failure: **email Garrett (info@retmediaagency.com)** and stop. Do not read a token out of this repo (there is none).

## Non-goals

- No YouTube, TikTok, Reels, existing Stories, or Metricool live queue as the source
- No feed post and no Reel as the destination
- No Snap
- No new Grok routine
- No passwords, tokens, or session files in this repo
- No client email
- No trim and no crop
- No second wave that breaks the cap of 20

## Related

- Automations index: [`README.md`](README.md)
- Client note: [`../context/clients/blair.md`](../context/clients/blair.md)
- Locks: [`../context/commercial-locks.md`](../context/commercial-locks.md)
- Hands off: [`../context/hands-off.md`](../context/hands-off.md)
