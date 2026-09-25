#!/usr/bin/env python3
"""Mock-only tests for the Blair Facebook Stories publisher. No network."""

from __future__ import annotations

import json
import tempfile
import unittest
import urllib.parse
from datetime import datetime, timedelta
from pathlib import Path

import blair_fb_stories as job

TOKEN = "page-token-secret"
PAGE_ID = "998877665544"
NOW = datetime(2026, 9, 25, 9, 0, tzinfo=job.TZ)


def box(box_type: bytes, payload: bytes) -> bytes:
    size = 8 + len(payload)
    return size.to_bytes(4, "big") + box_type + payload


def mp4(seconds: float, timescale: int = 1000) -> bytes:
    duration = int(round(seconds * timescale))
    payload = (
        b"\x00\x00\x00\x00"
        + b"\x00\x00\x00\x00"
        + b"\x00\x00\x00\x00"
        + timescale.to_bytes(4, "big")
        + duration.to_bytes(4, "big")
        + b"\x00" * 16
    )
    return box(b"mdat", b"\x00" * 8) + box(b"moov", box(b"mvhd", payload))


def post(video_id: str, created: str, **overrides) -> dict:
    attachment = {
        "type": "video",
        "media_type": "video",
        "url": f"https://www.facebook.com/{PAGE_ID}/videos/{video_id}",
        "target": {"id": video_id},
    }
    body = {
        "id": f"{PAGE_ID}_{video_id}",
        "created_time": created,
        "is_published": True,
        "status_type": "added_video",
        "attachments": {"data": [attachment]},
    }
    body.update(overrides)
    return body


class ScriptedHttp(job.HttpClient):
    def __init__(self, responder) -> None:
        self.calls = []
        self.responder = responder

    def send(self, method, url, *, headers=None, body=None, max_bytes=None):
        call = {
            "method": method,
            "url": url,
            "headers": dict(headers or {}),
            "body": body,
        }
        self.calls.append(call)
        status, payload = self.responder(call)
        raw = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        return job.HttpResult(status, raw)


def path_of(url: str) -> str:
    return urllib.parse.urlsplit(url).path


def form_of(body: bytes | None) -> dict:
    return dict(urllib.parse.parse_qsl((body or b"").decode()))


class PureTests(unittest.TestCase):
    def test_duration_bounds_and_parser(self) -> None:
        self.assertEqual(job.parse_mp4_duration_seconds(mp4(10)), 10)
        self.assertEqual(job.parse_mp4_duration_seconds(mp4(60)), 60)
        self.assertTrue(job.duration_ok(3))
        self.assertTrue(job.duration_ok(60))
        self.assertFalse(job.duration_ok(2.999))
        self.assertFalse(job.duration_ok(60.001))
        self.assertFalse(job.duration_ok(90))
        self.assertIsNone(job.parse_mp4_duration_seconds(b"not a video"))

    def test_story_spec_is_nine_by_sixteen_and_minimum_size(self) -> None:
        self.assertTrue(job.format_meets_story_spec(1080, 1920))
        self.assertTrue(job.format_meets_story_spec(540, 960))
        self.assertFalse(job.format_meets_story_spec(1920, 1080))
        self.assertFalse(job.format_meets_story_spec(480, 854))
        self.assertEqual(job.largest_format([{"width": 540, "height": 960}, {"width": 1080, "height": 1920}]), (1080, 1920))

    def test_views_parser_uses_lifetime_total_video_views(self) -> None:
        payload = {
            "data": [
                {
                    "name": "total_video_views",
                    "period": "lifetime",
                    "values": [{"value": 10000}],
                }
            ]
        }
        self.assertEqual(job.lifetime_total_views(payload), 10000)
        self.assertIsNone(job.lifetime_total_views({"data": []}))
        self.assertIsNone(job.lifetime_total_views({"data": [{"name": "total_video_views_unique", "values": [{"value": 5}]}]}))

    def test_pacific_start_boundary(self) -> None:
        self.assertEqual(job.candidates_from_post(post("1", "2025-12-31T23:59:59-0800")), [])
        self.assertEqual(job.candidates_from_post(post("1", "2026-01-01T07:59:59+0000")), [])
        kept = job.candidates_from_post(post("1", "2026-01-01T08:00:00+0000"))
        self.assertEqual([item.video_id for item in kept], ["1"])
        kept = job.candidates_from_post(post("2", "2026-01-01T00:00:00-0800"))
        self.assertEqual([item.video_id for item in kept], ["2"])

    def test_source_filters(self) -> None:
        self.assertEqual(job.candidates_from_post(post("1", "2026-02-01T00:00:00-0800", is_published=False)), [])
        self.assertEqual(job.candidates_from_post(post("1", "2026-02-01T00:00:00-0800", status_type="shared_story")), [])
        self.assertEqual(job.candidates_from_post(post("1", "2026-02-01T00:00:00-0800", status_type="published_story")), [])
        photo = post("1", "2026-02-01T00:00:00-0800")
        photo["attachments"]["data"][0]["type"] = "photo"
        photo["attachments"]["data"][0]["media_type"] = "photo"
        self.assertEqual(job.candidates_from_post(photo), [])
        reel = post("1", "2026-02-01T00:00:00-0800")
        reel["attachments"]["data"][0]["url"] = "https://www.facebook.com/reel/55"
        self.assertEqual(job.candidates_from_post(reel), [])
        story = post("1", "2026-02-01T00:00:00-0800")
        story["attachments"]["data"][0]["url"] = "https://www.facebook.com/stories/55"
        self.assertEqual(job.candidates_from_post(story), [])
        link = post("1", "2026-02-01T00:00:00-0800")
        link["attachments"]["data"][0]["type"] = "link"
        link["attachments"]["data"][0]["media_type"] = "link"
        link["attachments"]["data"][0]["url"] = "https://www.youtube.com/watch?v=abc"
        self.assertEqual(job.candidates_from_post(link), [])

    def test_posted_today_uses_pacific_dates(self) -> None:
        ledger = {
            "posted": {
                "a": {"posted_at": "2026-09-25T06:30:00+00:00"},
                "b": {"posted_at": "2026-09-25T07:00:00+00:00"},
            }
        }
        self.assertEqual(job.posted_today(ledger, NOW.date()), 1)

    def test_config_blocks_missing_or_in_repo_secrets(self) -> None:
        with self.assertRaises(job.ConfigError):
            job.load_config({}, job.REPO_ROOT)
        with self.assertRaises(job.ConfigError):
            job.load_config({"BLAIR_FB_PAGE_ID": "BlairConklin", "BLAIR_FB_PAGE_TOKEN": TOKEN}, job.REPO_ROOT)
        with self.assertRaises(job.ConfigError):
            job.load_config(
                {
                    "BLAIR_FB_PAGE_ID": PAGE_ID,
                    "BLAIR_FB_PAGE_TOKEN_FILE": str(job.REPO_ROOT / "README.md"),
                },
                job.REPO_ROOT,
            )
        with self.assertRaises(job.ConfigError):
            job.load_config(
                {
                    "BLAIR_FB_PAGE_ID": PAGE_ID,
                    "BLAIR_FB_PAGE_TOKEN": TOKEN,
                    "BLAIR_FB_STORIES_LEDGER": str(job.REPO_ROOT / "ledger.json"),
                },
                job.REPO_ROOT,
            )


class RunTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.ledger = Path(self.tmp.name) / "ledger.json"
        self.emails: list[tuple[str, str]] = []

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def notify(self, subject: str, body: str) -> None:
        self.emails.append((subject, body))

    def env(self) -> dict:
        return {
            "BLAIR_FB_PAGE_ID": PAGE_ID,
            "BLAIR_FB_PAGE_TOKEN": TOKEN,
            "BLAIR_FB_STORIES_LEDGER": str(self.ledger),
        }

    def assert_no_token(self) -> None:
        blob = "\n".join(subject + "\n" + body for subject, body in self.emails)
        self.assertNotIn(TOKEN, blob)

    def test_publishes_story_only_and_records_ledger(self) -> None:
        media = mp4(12)
        video_id = "501"

        def respond(call):
            path = path_of(call["url"])
            if call["method"] == "GET" and path.endswith("/feed"):
                return 200, {"data": [post(video_id, "2026-03-01T12:00:00-0800")]}
            if path.endswith("/video_insights"):
                return 200, insight(10000)
            if path.endswith("/" + video_id):
                return 200, video_node(video_id)
            if path.endswith("/v.mp4"):
                return 200, media
            if path.endswith("/video_stories"):
                fields = form_of(call["body"])
                self.assertNotIn("file_url", fields)
                self.assertNotIn("description", fields)
                if fields.get("upload_phase") == "start":
                    self.assertEqual(set(fields), {"upload_phase", "access_token"})
                    return 200, {
                        "video_id": "storyvid",
                        "upload_url": "https://rupload.facebook.com/video-upload/v26.0/storyvid",
                    }
                self.assertEqual(fields.get("upload_phase"), "finish")
                self.assertEqual(fields.get("video_id"), "storyvid")
                self.assertEqual(set(fields), {"upload_phase", "video_id", "access_token"})
                return 200, {"success": True, "post_id": "story-post-1"}
            if urllib.parse.urlsplit(call["url"]).hostname == "rupload.facebook.com":
                self.assertEqual(call["headers"].get("offset"), "0")
                self.assertEqual(call["headers"].get("file_size"), str(len(media)))
                self.assertNotIn("file_url", call["headers"])
                self.assertEqual(call["body"], media)
                return 200, {"success": True}
            raise AssertionError(path)

        http = ScriptedHttp(respond)
        code = job.execute([], self.env(), http, self.notify, NOW, job.REPO_ROOT)
        self.assertEqual(code, 0)
        self.assertEqual(self.emails, [])
        posts = [path_of(call["url"]) for call in http.calls if call["method"] == "POST"]
        self.assertTrue(all(item.endswith("/video_stories") or "rupload" in item for item in [
            call["url"] for call in http.calls if call["method"] == "POST"
        ]))
        self.assertFalse(any(path.endswith("/videos") or path.endswith("/video_reels") for path in posts))
        saved = json.loads(self.ledger.read_text())
        self.assertEqual(saved["posted"]["501"]["story_post_id"], "story-post-1")
        self.assert_no_token()
        self.assertNotIn(TOKEN, self.ledger.read_text())

    def test_skips_long_low_view_and_horizontal_without_upload(self) -> None:
        rows = {
            "1": (mp4(61), 20000, 1080, 1920),
            "2": (mp4(10), 9999, 1080, 1920),
            "3": (mp4(10), 20000, 1920, 1080),
            "4": (mp4(10), 20000, 1080, 1920),
        }

        def respond(call):
            path = path_of(call["url"])
            if path.endswith("/feed"):
                return 200, {
                    "data": [
                        post("1", "2026-01-02T00:00:00-0800"),
                        post("2", "2026-01-03T00:00:00-0800"),
                        post("3", "2026-01-04T00:00:00-0800"),
                        post("4", "2026-01-05T00:00:00-0800"),
                    ]
                }
            video_id = path.rstrip("/").split("/")[-1]
            if video_id.endswith("video_insights"):
                video_id = path.split("/")[-2]
                return 200, insight(rows[video_id][1])
            if path.endswith("/v.mp4"):
                video_id = urllib.parse.parse_qs(urllib.parse.urlsplit(call["url"]).query)["video"][0]
                return 200, rows[video_id][0]
            if call["method"] == "GET":
                width, height = rows[video_id][2], rows[video_id][3]
                node = video_node(video_id, width, height)
                return 200, node
            if path.endswith("/video_stories") and form_of(call["body"]).get("upload_phase") == "start":
                return 200, {
                    "video_id": "new" + video_id,
                    "upload_url": "https://rupload.facebook.com/video-upload/v26.0/new" + video_id,
                }
            if urllib.parse.urlsplit(call["url"]).hostname == "rupload.facebook.com":
                return 200, {"success": True}
            if path.endswith("/video_stories"):
                return 200, {"success": True, "post_id": "sp"}
            raise AssertionError(path)

        http = ScriptedHttp(respond)
        code = job.execute([], self.env(), http, self.notify, NOW, job.REPO_ROOT)
        self.assertEqual(code, 0)
        saved = json.loads(self.ledger.read_text())
        self.assertEqual(list(saved["posted"]), ["4"])
        uploaded = [call for call in http.calls if urllib.parse.urlsplit(call["url"]).hostname == "rupload.facebook.com"]
        self.assertEqual(len(uploaded), 1)

    def test_oldest_first_and_daily_cap(self) -> None:
        ids = [str(1000 + index) for index in range(21)]

        def respond(call):
            path = path_of(call["url"])
            if path.endswith("/feed"):
                data = [
                    post(video_id, (job.START + timedelta(days=20 - index)).isoformat())
                    for index, video_id in enumerate(ids)
                ]
                return 200, {"data": data}
            if path.endswith("/video_insights"):
                return 200, insight(15000)
            if path.endswith("/v.mp4"):
                return 200, mp4(8)
            if call["method"] == "GET":
                return 200, video_node(path.rstrip("/").split("/")[-1])
            if path.endswith("/video_stories") and form_of(call["body"]).get("upload_phase") == "start":
                return 200, {
                    "video_id": "n1",
                    "upload_url": "https://rupload.facebook.com/video-upload/v26.0/n1",
                }
            if urllib.parse.urlsplit(call["url"]).hostname == "rupload.facebook.com":
                return 200, {"success": True}
            if path.endswith("/video_stories"):
                return 200, {"success": True, "post_id": "sp"}
            raise AssertionError(path)

        http = ScriptedHttp(respond)
        code = job.execute([], self.env(), http, self.notify, NOW, job.REPO_ROOT)
        self.assertEqual(code, 0)
        saved = json.loads(self.ledger.read_text())
        insight_ids = [
            path_of(call["url"]).split("/")[-2]
            for call in http.calls
            if path_of(call["url"]).endswith("/video_insights")
        ]
        oldest_twenty = [str(1020 - index) for index in range(20)]
        self.assertEqual(insight_ids, oldest_twenty)
        self.assertEqual(set(saved["posted"]), set(oldest_twenty))
        self.assertNotIn("1000", saved["posted"])

    def test_same_day_ledger_counts_toward_cap(self) -> None:
        existing = {
            "posted": {
                str(index): {"posted_at": NOW.isoformat(), "story_post_id": "old", "source_post_id": "p"}
                for index in range(19)
            }
        }
        self.ledger.write_text(json.dumps(existing))

        def respond(call):
            path = path_of(call["url"])
            if path.endswith("/feed"):
                return 200, {
                    "data": [
                        post("301", "2026-01-02T00:00:00-0800"),
                        post("302", "2026-01-03T00:00:00-0800"),
                    ]
                }
            if path.endswith("/video_insights"):
                return 200, insight(15000)
            if path.endswith("/v.mp4"):
                return 200, mp4(8)
            if call["method"] == "GET":
                return 200, video_node("301")
            if path.endswith("/video_stories") and form_of(call["body"]).get("upload_phase") == "start":
                return 200, {"video_id": "n", "upload_url": "https://rupload.facebook.com/video-upload/v26.0/n"}
            if urllib.parse.urlsplit(call["url"]).hostname == "rupload.facebook.com":
                return 200, {"success": True}
            if path.endswith("/video_stories"):
                return 200, {"success": True, "post_id": "sp"}
            raise AssertionError(path)

        http = ScriptedHttp(respond)
        code = job.execute([], self.env(), http, self.notify, NOW, job.REPO_ROOT)
        self.assertEqual(code, 0)
        saved = json.loads(self.ledger.read_text())
        self.assertIn("301", saved["posted"])
        self.assertNotIn("302", saved["posted"])
        self.assertEqual(len(saved["posted"]), 20)

    def test_already_posted_is_not_uploaded_again(self) -> None:
        self.ledger.write_text(
            json.dumps(
                {
                    "posted": {
                        "401": {
                            "posted_at": "2026-02-01T10:00:00-08:00",
                            "story_post_id": "old",
                            "source_post_id": "p",
                        }
                    }
                }
            )
        )

        def respond(call):
            path = path_of(call["url"])
            if path.endswith("/feed"):
                return 200, {"data": [post("401", "2026-01-10T00:00:00-0800")]}
            raise AssertionError(path)

        http = ScriptedHttp(respond)
        code = job.execute([], self.env(), http, self.notify, NOW, job.REPO_ROOT)
        self.assertEqual(code, 0)
        self.assertTrue(all(path_of(call["url"]).endswith("/feed") for call in http.calls))

    def test_rate_limit_and_token_stop_without_a_story_post(self) -> None:
        def rate(call):
            return 400, {"error": {"message": "(#4) Application request limit reached", "type": "OAuthException", "code": 4}}

        http = ScriptedHttp(rate)
        code = job.execute([], self.env(), http, self.notify, NOW, job.REPO_ROOT)
        self.assertEqual(code, 1)
        self.assertFalse(self.ledger.exists())
        self.assertTrue(self.emails)
        self.assertEqual(http.calls[0]["method"], "GET")
        self.assert_no_token()

        self.emails.clear()

        def token_error(call):
            path = path_of(call["url"])
            if path.endswith("/feed"):
                return 200, {"data": [post("8", "2026-04-01T00:00:00-0700")]}
            return 400, {
                "error": {
                    "message": f"Error validating access token {TOKEN}",
                    "type": "OAuthException",
                    "code": 190,
                }
            }

        http = ScriptedHttp(token_error)
        code = job.execute([], self.env(), http, self.notify, NOW, job.REPO_ROOT)
        self.assertEqual(code, 1)
        self.assertFalse(self.ledger.exists())
        self.assertNotIn(TOKEN, self.emails[-1][1])

    def test_previously_published_rejection_stops(self) -> None:
        def respond(call):
            path = path_of(call["url"])
            if path.endswith("/feed"):
                return 200, {"data": [post("9", "2026-04-02T00:00:00-0700")]}
            if path.endswith("/video_insights"):
                return 200, insight(12000)
            if path.endswith("/v.mp4"):
                return 200, mp4(9)
            if call["method"] == "GET":
                return 200, video_node("9")
            if path.endswith("/video_stories"):
                return 400, {
                    "error": {
                        "message": "A video uploaded for a story can not have been used in a previously published post",
                        "code": 100,
                    }
                }
            if urllib.parse.urlsplit(call["url"]).hostname == "rupload.facebook.com":
                return 200, {"success": True}
            raise AssertionError(path)

        http = ScriptedHttp(respond)
        code = job.execute([], self.env(), http, self.notify, NOW, job.REPO_ROOT)
        self.assertEqual(code, 1)
        self.assertFalse(self.ledger.exists())
        self.assertIn("previously published", self.emails[-1][1])

    def test_dry_run_does_not_post(self) -> None:
        def respond(call):
            path = path_of(call["url"])
            if call["method"] == "POST":
                raise AssertionError("dry run posted")
            if path.endswith("/feed"):
                return 200, {"data": [post("77", "2026-05-01T00:00:00-0700")]}
            if path.endswith("/video_insights"):
                return 200, insight(11000)
            if path.endswith("/v.mp4"):
                return 200, mp4(5)
            return 200, video_node("77")

        http = ScriptedHttp(respond)
        code = job.execute(["--dry-run"], self.env(), http, self.notify, NOW, job.REPO_ROOT)
        self.assertEqual(code, 0)
        self.assertFalse(self.ledger.exists())
        self.assertFalse(any(call["method"] == "POST" for call in http.calls))

    def test_missing_page_credentials_block_without_network(self) -> None:
        http = ScriptedHttp(lambda call: (_ for _ in ()).throw(AssertionError("network")))
        code = job.execute([], {}, http, self.notify, NOW, job.REPO_ROOT)
        self.assertEqual(code, 2)
        self.assertIn("Blocked", self.emails[-1][1])
        self.assertEqual(http.calls, [])

    def test_bad_paging_host_stops(self) -> None:
        def respond(call):
            if path_of(call["url"]).endswith("/feed") and "evil" not in call["url"]:
                return 200, {
                    "data": [],
                    "paging": {"next": f"https://evil.example/feed?access_token={TOKEN}"},
                }
            raise AssertionError(call["url"])

        http = ScriptedHttp(respond)
        code = job.execute([], self.env(), http, self.notify, NOW, job.REPO_ROOT)
        self.assertEqual(code, 1)
        self.assert_no_token()


def insight(views: int) -> dict:
    return {
        "data": [
            {
                "name": "total_video_views",
                "period": "lifetime",
                "values": [{"value": views}],
                "title": "Lifetime Total Video Views",
            }
        ]
    }


def video_node(video_id: str, width: int = 1080, height: int = 1920) -> dict:
    return {
        "id": video_id,
        "source": f"https://cdn.example/v.mp4?video={video_id}",
        "format": [{"width": width, "height": height}],
    }


if __name__ == "__main__":
    unittest.main()
