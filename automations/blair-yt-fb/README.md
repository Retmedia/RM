# Blair YouTube to Facebook

Daily job for Blair Conklin's Skid Kids channel (`@SkidKids`). It posts new long-form YouTube videos to his Facebook page as 1080x1080 square videos. One video is downloaded, encoded, uploaded, and deleted before the next one starts.

Schedule: 17:00 UTC every day (`0 17 * * *`). That is 9:00am Pacific Standard Time. During Pacific Daylight Time the same cron is 10:00am Pacific.

Manual runs use the Actions "Run workflow" button. Turn on **Dry run** to skip the upload.

## What it posts

1. Read the public channel RSS feed for channel id `UCQ5kqUO7Pkc7YWRNnjetfbw`:
   `https://www.youtube.com/feeds/videos.xml?channel_id=UCQ5kqUO7Pkc7YWRNnjetfbw`
2. Keep uploads from the last 7 days. Skip Shorts. A Short is any item whose link contains `/shorts/`, or any video shorter than 3 minutes. Duration comes from yt-dlp.
3. If the RSS request fails, resolve `@SkidKids` with yt-dlp and try the feed again. If that still fails, list the channel videos tab with yt-dlp. If the RSS page is full and still inside the 7 day window, yt-dlp supplements it so older long-form uploads are not hidden behind Shorts.
4. Skip anything already in `posted.json`, and anything whose YouTube id or exact title already shows up on the page. The page check reads recent reels, videos, and scheduled posts.
5. Oldest missing video first. Download the best mp4 up to 1080p, then encode:

   `scale=1080:1080:force_original_aspect_ratio=increase,crop=1080:1080,setsar=1`

   H.264 video, AAC stereo. The scale fills the square and the crop keeps the center, so the frame has no black bars and no blurred pillars. Three frames (25%, 50%, 75%) are checked. A black edge on all three fails that video.
6. Upload with the Graph API resumable video upload (`upload_phase` start, transfer, finish) on `graph-video.facebook.com`. The caption is the YouTube title, unchanged. The same string is sent as the video title and the description.
7. The YouTube `maxresdefault` thumbnail is attached when Facebook accepts it (`/{video-id}/thumbnails`). If the API rejects the thumbnail, the video still counts as posted and the log says so.
8. The oldest successful upload publishes immediately. Each later success is scheduled 2 hours after the previous one (`scheduled_publish_time`). Facebook's minimum lead is 10 minutes; this job keeps at least 15.

`posted.json` is updated after each successful upload. The workflow commits that file back to the branch. A failed video is not recorded, so a later run can retry it. Other videos in the same run still upload. Any error exits non-zero so GitHub can email the failure.

Dry run does the list, dedupe, download, encode, and frame check, then deletes the temp files. It does not upload and it does not change `posted.json`. Dry run still needs the two secrets so the Facebook dedupe check is real.

## Secrets

Do not commit tokens. Add both secrets under GitHub: **Settings, Secrets and variables, Actions, New repository secret.**

| Name | Value |
| --- | --- |
| `FB_PAGE_ID` | Numeric Facebook Page id |
| `FB_PAGE_ACCESS_TOKEN` | Long-lived Page access token |

The token needs `pages_manage_posts`, `pages_read_engagement`, and `publish_video`. Current Graph video publishing also expects `pages_show_list` and a Page role that can create content, so include `pages_show_list` when you mint the token.

How to mint it:

1. Open [Graph API Explorer](https://developers.facebook.com/tools/explorer/) for the Meta app that owns this Page.
2. Grant the user token `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`, and `publish_video`.
3. Exchange that short-lived user token for a long-lived user token.
4. Call `GET /me/accounts`.
5. Copy the Page `id` into `FB_PAGE_ID`.
6. Copy that Page's `access_token` into `FB_PAGE_ACCESS_TOKEN`. A page token created from a long-lived user token does not use the 60-day user-token clock.

The default branch has to allow `github-actions[bot]` to push `automations/blair-yt-fb/posted.json`. If branch protection blocks that push, the upload can still succeed and the job then fails on the commit step. Facebook title dedupe is the backstop until the state file lands.

## Manual run

1. Open the **Actions** tab.
2. Choose **Blair YouTube to Facebook**.
3. Click **Run workflow**.
4. Leave **Dry run** off to publish. Turn it on to test without uploading.
5. Click **Run workflow** again to start the run.

Pull requests only run the unit tests. They do not post.

## Failure mail

The script exits with status 1 when setup, listing, a download, the encode, the frame check, or an upload fails. GitHub Actions marks the workflow as failed. Failure mail goes to people whose notification settings include Actions failures (the account that last edited this workflow also gets scheduled-run failures). Turn those notifications on for the inbox that should see them.

Temp files live under `/tmp/blair-yt-fb` and are deleted at the end of each video, including yt-dlp's cache for that video. The job refuses to start a download when less than 3 GiB is free.

If YouTube tells yt-dlp to sign in to prove it is not a bot, that command exits non-zero and this workflow fails. The video is not marked posted, so a later run retries it.

## Why this is not the Reels publishing edge

`POST /{page-id}/video_reels` only accepts 9:16 video between 3 and 90 seconds. This job skips anything under 3 minutes and encodes a 1:1 square, so that edge would reject every file. Facebook's creator docs call a Page video a Reel whether it is short or long, vertical or square. The upload uses the Page Videos resumable API, which accepts this file, sets the caption, takes a thumbnail, and supports `scheduled_publish_time` (between 10 minutes and 6 months ahead).
