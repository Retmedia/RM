#!/usr/bin/env python3
"""Offline tests for the Blair YouTube to Facebook job."""

from __future__ import annotations

import contextlib
import io
import shutil
import subprocess
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import blair_yt_fb as job

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[1]
HAS_FFMPEG = shutil.which("ffmpeg") and shutil.which("ffprobe")


def utc(year, month, day, hour=0, minute=0):
    return datetime(year, month, day, hour, minute, tzinfo=timezone.utc)


class ParseAndFilterTests(unittest.TestCase):
    def test_real_rss_fixture_keeps_exact_titles(self):
        videos = job.parse_rss((ROOT / "fixtures" / "skidkids_rss_sample.xml").read_bytes())
        by_id = {video.video_id: video for video in videos}
        self.assertGreaterEqual(len(videos), 15)
        longform = by_id["0nc9m2-iQWw"]
        self.assertEqual(longform.title, "Will Pacific Coast HWY Survive the Winter?")
        self.assertFalse(job.is_short_url(longform.url))
        self.assertTrue(job.is_short_url(by_id["CTfcSOr_5x8"].url))
        self.assertTrue(longform.published.tzinfo is not None)

    def test_rss_rejects_garbage(self):
        with self.assertRaises(RuntimeError):
            job.parse_rss(b"<not xml")

    def test_feed_truncated_only_when_page_is_full_and_fresh(self):
        fresh = utc(2026, 11, 2)
        cutoff = fresh - timedelta(days=7)
        page = [
            job.Video(f"vid{i:07d}", "t", fresh - timedelta(hours=i), "https://www.youtube.com/watch?v=x")
            for i in range(15)
        ]
        self.assertTrue(job.feed_is_truncated(page, cutoff))
        self.assertFalse(job.feed_is_truncated(page[:14], cutoff))
        old = [
            job.Video("abcdefghijk", "t", cutoff - timedelta(hours=1), "https://www.youtube.com/watch?v=abcdefghijk")
        ] + page[1:]
        self.assertFalse(job.feed_is_truncated(old, cutoff))

    def test_classify_shorts_duration_and_live(self):
        base = job.Video("abcdefghijk", "Title", utc(2026, 11, 1), "https://www.youtube.com/watch?v=abcdefghijk", 600, "not_live")
        keep, reason = job.classify(base)
        self.assertTrue(keep)
        self.assertEqual(reason, "longform")

        short_url = job.Video("abcdefghijk", "Title", utc(2026, 11, 1), "https://www.youtube.com/shorts/abcdefghijk", 600, "not_live")
        self.assertEqual(job.classify(short_url), (False, "shorts_url"))

        brief = job.Video("abcdefghijk", "Title", utc(2026, 11, 1), base.url, 179.9, "not_live")
        self.assertEqual(job.classify(brief)[1], "under_3_min")

        exact = job.Video("abcdefghijk", "Title", utc(2026, 11, 1), base.url, 180, "not_live")
        self.assertTrue(job.classify(exact)[0])

        live = job.Video("abcdefghijk", "Title", utc(2026, 11, 1), base.url, 600, "is_live")
        self.assertEqual(job.classify(live)[1], "live:is_live")

        unknown = job.Video("abcdefghijk", "Title", utc(2026, 11, 1), base.url, None, "not_live")
        self.assertEqual(job.classify(unknown)[1], "duration_unknown")

    def test_caption_is_the_exact_title(self):
        title = "Record Breaking High Tides: California has a Problem \u2014 extra "
        self.assertEqual(job.caption_for(title), title)
        spaced = "Hello  world "
        self.assertEqual(job.caption_for(spaced), spaced)
        self.assertEqual(job.norm_text(spaced), "Hello world")
        self.assertNotEqual(job.norm_text(spaced), spaced.strip())
        with self.assertRaises(ValueError):
            job.caption_for("   ")

    def test_dedupe_state_title_and_url(self):
        video = job.Video("0nc9m2-iQWw", "Kelvin Wave VS Hotel", utc(2026, 10, 31), "https://www.youtube.com/watch?v=0nc9m2-iQWw", 400)
        state = {"posted": {}}
        texts = ["something else"]
        self.assertIsNone(job.is_duplicate(video, state, texts))

        state["posted"]["0nc9m2-iQWw"] = {"title": video.title}
        self.assertEqual(job.is_duplicate(video, state, texts), "state")

        state = {"posted": {}}
        self.assertEqual(job.is_duplicate(video, state, ["Kelvin  Wave\u00a0VS Hotel"]), "facebook_title")
        self.assertEqual(
            job.is_duplicate(video, state, ["see https://www.youtube.com/watch?v=0nc9m2-iQWw"]),
            "facebook_url",
        )
        self.assertIsNone(job.is_duplicate(video, state, ["Kelvin Wave VS Hotels"]))

    def test_schedule_publishes_first_success_then_gaps(self):
        cursor = job.ScheduleCursor()
        start = utc(2026, 11, 2, 17)
        self.assertIsNone(cursor.peek(start))
        cursor.commit(None, start)
        second = cursor.peek(start + timedelta(minutes=20))
        self.assertEqual(second, start + timedelta(hours=2))
        cursor.commit(second, start + timedelta(minutes=20))
        third = cursor.peek(start + timedelta(minutes=25))
        self.assertEqual(third, second + timedelta(hours=2))

        late = job.ScheduleCursor()
        late.commit(None, start)
        slipped = late.peek(start + timedelta(hours=3))
        self.assertEqual(slipped, start + timedelta(hours=3, minutes=15))

    def test_download_command_is_mp4_upto_1080(self):
        url = "https://www.youtube.com/watch?v=0nc9m2-iQWw"
        cmd = job.ytdlp_download_cmd("yt-dlp", url, "source.%(ext)s", "/tmp/cache")
        self.assertEqual(cmd[0], "yt-dlp")
        self.assertEqual(cmd[-1], url)
        self.assertTrue(any("bv*[ext=mp4][height<=1080]+ba[ext=m4a]" in part for part in cmd))
        self.assertIn("--merge-output-format", cmd)
        self.assertNotIn("shell", cmd)
        self.assertTrue(job.SCALE_FILTER.startswith(
            "scale=1080:1080:force_original_aspect_ratio=increase,crop=1080:1080"
        ))

    def test_channel_id_is_hardcoded(self):
        self.assertEqual(job.CHANNEL_ID, "UCQ5kqUO7Pkc7YWRNnjetfbw")
        self.assertIn(job.CHANNEL_ID, job.RSS_URL)
        self.assertTrue(job.is_youtube_id("0nc9m2-iQWw"))
        self.assertTrue(job.is_youtube_id("-VaDKGH5Fts"))
        self.assertFalse(job.is_youtube_id("not an id"))

    def test_state_roundtrip_and_corrupt_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "posted.json"
            state = job.load_state(path)
            video = job.Video("0nc9m2-iQWw", "Exact title ", utc(2026, 11, 2, 4, 36), "https://www.youtube.com/watch?v=0nc9m2-iQWw")
            when = utc(2026, 11, 2, 19)
            job.record_post(state, video, "9988", when, utc(2026, 11, 2, 17, 5))
            job.save_state(path, state)
            loaded = job.load_state(path)
            self.assertEqual(loaded["posted"]["0nc9m2-iQWw"]["title"], "Exact title ")
            self.assertEqual(loaded["posted"]["0nc9m2-iQWw"]["facebook_video_id"], "9988")
            self.assertFalse(path.with_suffix(".json.tmp").exists())
            path.write_text("{", encoding="utf-8")
            with self.assertRaises(RuntimeError):
                job.load_state(path)

    def test_graph_errors_and_retries(self):
        with self.assertRaises(job.GraphError):
            job.parse_graph_body(400, b'{"error":{"message":"nope","code":190}}')
        with self.assertRaises(job.RetryableError):
            job.parse_graph_body(503, b'{"error":{"message":"later","code":1}}')
        calls = {"n": 0}

        def flaky():
            calls["n"] += 1
            if calls["n"] < 3:
                raise job.RetryableError("nope")
            return "ok"

        self.assertEqual(job.with_retries("flaky", flaky, sleeper=lambda _delay: None), "ok")

    def test_offsets_and_multipart_slice(self):
        self.assertEqual(job._offsets({"start_offset": "0", "end_offset": "4"}), (0, 4))
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "video.bin"
            path.write_bytes(b"abcdefghij")
            reader = job._multipart(
                [("upload_phase", "transfer"), ("start_offset", "2")],
                ("video_file_chunk", "square.mp4", "video/mp4", path, 2, 6),
            )
            body = reader.read()
            self.assertIn(b"cdef", body)
            self.assertNotIn(b"ab", body[:20])
            self.assertEqual(len(body), reader.length)

    def test_multipart_posts_to_local_server(self):
        received = {}

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers["Content-Length"])
                received["body"] = self.rfile.read(length)
                received["type"] = self.headers["Content-Type"]
                payload = b'{"success": true}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, fmt, *args):
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.handle_request)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp) / "square.mp4"
                path.write_bytes(b"0123456789abcdef")
                result = job.post_multipart(
                    f"http://127.0.0.1:{server.server_address[1]}/upload",
                    [("upload_phase", "transfer")],
                    ("video_file_chunk", "square.mp4", "video/mp4", path, 4, 10),
                    timeout=10,
                )
            self.assertTrue(result["success"])
            self.assertIn(b"456789", received["body"])
            self.assertIn(b"multipart/form-data", received["type"].encode())
            self.assertEqual(len(received["body"]), int(received["type"] and received["body"].__len__()))
        finally:
            thread.join(timeout=5)
            server.server_close()

    def test_jpeg_size_and_black_edge_math(self):
        width, height = 20, 20
        rgb = bytearray([20, 20, 20]) * (width * height)
        for y in range(8):
            for x in range(width):
                index = (y * width + x) * 3
                rgb[index:index + 3] = b"\x00\x00\x00"
        stats = {item.side: item for item in job.black_edges_on_frame(bytes(rgb), width, height)}
        self.assertTrue(stats["top"].is_black)
        self.assertFalse(stats["bottom"].is_black)

    def test_workflow_and_readme_contract(self):
        workflow = (REPO / ".github" / "workflows" / "blair-yt-fb.yml").read_text(encoding="utf-8")
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        root_readme = (REPO / "README.md").read_text(encoding="utf-8")
        section = root_readme.split("## Blair YouTube to Facebook", 1)[1].split("## Other trees", 1)[0]
        self.assertIn("0 17 * * *", workflow)
        self.assertIn("workflow_dispatch", workflow)
        self.assertIn("FB_PAGE_ID", workflow)
        self.assertIn("FB_PAGE_ACCESS_TOKEN", workflow)
        self.assertIn("dry_run", workflow)
        self.assertIn("FB_PAGE_ID", readme)
        self.assertIn("FB_PAGE_ACCESS_TOKEN", readme)
        self.assertIn("Dry run", readme)
        self.assertIn("FB_PAGE_ID", section)
        self.assertIn("Run workflow", section)
        for text, name in (
            ((ROOT / "blair_yt_fb.py").read_text(encoding="utf-8"), "blair_yt_fb.py"),
            (readme, "README.md"),
            (section, "root section"),
            (workflow, "workflow"),
            ((ROOT / "test_blair_yt_fb.py").read_text(encoding="utf-8"), "tests"),
        ):
            self.assertNotIn("\u2014", text, name)
            self.assertNotIn("\u2013", text, name)

    def test_env_flag(self):
        self.assertFalse(job.env_flag("NOT_A_REAL_FLAG_BLAIR"))


@unittest.skipUnless(HAS_FFMPEG, "ffmpeg is required")
class EncodeTests(unittest.TestCase):
    def _clip(self, dest: Path, video_filter: str | None) -> None:
        cmd = [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", "color=c=0xcc2222:s=1920x1080:r=30:d=2",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
            "-shortest",
            "-c:v", "libx264", "-pix_fmt", "yuv420p",
            "-c:a", "aac",
        ]
        if video_filter:
            cmd.extend(["-vf", video_filter])
        cmd.append(str(dest))
        subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def test_scale_crop_is_square_without_black_edges(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "wide.mp4"
            square = Path(tmp) / "square.mp4"
            self._clip(source, None)
            job.encode_square(source, square)
            job.assert_no_black_edges(square)

    def test_side_pillars_are_cropped_away(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "pillars.mp4"
            square = Path(tmp) / "square.mp4"
            self._clip(
                source,
                "drawbox=x=0:y=0:w=180:h=ih:color=black:t=fill,drawbox=x=iw-180:y=0:w=180:h=ih:color=black:t=fill",
            )
            job.encode_square(source, square)
            job.assert_no_black_edges(square)

    def test_letterbox_fails_the_frame_check(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "letterbox.mp4"
            square = Path(tmp) / "square.mp4"
            self._clip(
                source,
                "drawbox=x=0:y=0:w=iw:h=100:color=black:t=fill,drawbox=x=0:y=ih-100:w=iw:h=100:color=black:t=fill",
            )
            job.encode_square(source, square)
            with self.assertRaises(RuntimeError) as caught:
                job.assert_no_black_edges(square)
            self.assertIn("black edges", str(caught.exception))

    def test_jpeg_dimensions(self):
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "thumb.jpg"
            subprocess.run(
                [
                    "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                    "-f", "lavfi", "-i", "color=c=blue:s=320x180",
                    "-frames:v", "1", str(dest),
                ],
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            self.assertEqual(job.jpeg_size(dest.read_bytes()), (320, 180))


class RedactTests(unittest.TestCase):
    def test_logs_do_not_keep_the_token(self):
        job._SECRETS.append("super-secret-token")
        try:
            buffer = io.StringIO()
            with contextlib.redirect_stdout(buffer):
                job.log("INFO", "token is super-secret-token")
            text = buffer.getvalue()
            self.assertNotIn("super-secret-token", text)
            self.assertIn("[redacted]", text)
        finally:
            job._SECRETS.remove("super-secret-token")


if __name__ == "__main__":
    unittest.main()
