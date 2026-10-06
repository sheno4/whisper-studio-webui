import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from yt_dlp.cookies import YoutubeDLCookieJar
from python import worker


class YouTubeAuthTests(unittest.TestCase):
    def setUp(self):
        self.logger = patch.object(worker, "log").start()
        self.addCleanup(patch.stopall)

    def test_youtube_host_does_not_match_lookalikes(self):
        self.assertTrue(worker.is_youtube_url("https://www.youtube.com/watch?v=test"))
        self.assertTrue(worker.is_youtube_url("https://youtu.be/test"))
        self.assertFalse(worker.is_youtube_url("https://evilyoutube.com/test"))
        self.assertFalse(worker.is_youtube_url("https://youtube.com.evil.test/test"))

    def test_installed_firefox_default_precedes_legacy_default(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "Mozilla" / "Firefox"
            for name in ("active", "legacy"):
                (root / name).mkdir(parents=True)
                (root / name / "cookies.sqlite").touch()
            (root / "profiles.ini").write_text(
                "[Profile0]\nPath=legacy\nDefault=1\n[InstallABC]\nDefault=active\n", encoding="utf-8"
            )
            with patch.dict(worker.os.environ, {"APPDATA": directory}):
                candidates = worker.youtube_login_candidates("auto", "ignored-old-profile", directory)
            self.assertEqual(candidates[0][1]["cookiesfrombrowser"][1], str(root / "active"))
            self.assertEqual(candidates[1][1]["cookiesfrombrowser"][1], str(root / "legacy"))

    def test_failed_profile_tries_next_and_returns_successful_session(self):
        first, second = MagicMock(), MagicMock()
        first.__enter__.return_value = first
        second.__enter__.return_value = second
        first.extract_info.side_effect = RuntimeError("membership required")
        second.extract_info.return_value = {"title": "Member video"}
        first_jar, second_jar = YoutubeDLCookieJar(), YoutubeDLCookieJar()
        with (
            patch.object(worker, "youtube_login_candidates", return_value=[("Firefox", {}), ("Chrome", {})]),
            patch("yt_dlp.YoutubeDL", side_effect=[first, second]),
            patch("yt_dlp.cookies.load_cookies", side_effect=[first_jar, second_jar]),
        ):
            info, jar = worker.probe_youtube_session("https://youtu.be/test", {}, "auto", "", "")
        self.assertEqual(info["title"], "Member video")
        self.assertIs(jar, second_jar)
        self.assertIs(second.cookiejar, second_jar)

    def test_member_failure_never_uses_anonymous_mirror(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(worker, "probe_youtube_session", side_effect=worker.WorkerFailure("youtube_login_failed", "member required")),
            patch.object(worker, "download_youtube_via_invidious") as mirror,
            patch.object(worker, "emit"),
        ):
            with self.assertRaises(worker.WorkerFailure):
                worker.download_media("https://youtu.be/test", Path(directory), "downloadOnly", "best")
            mirror.assert_not_called()

    def test_explicit_source_and_missing_cookie_file(self):
        candidates = worker.youtube_login_candidates("chrome", "Profile 2", "")
        self.assertEqual(candidates, [("Chrome", {"cookiesfrombrowser": ("chrome", "Profile 2", None, None)})])
        self.assertEqual(worker.youtube_login_candidates("none", "", ""), [("未登录", {})])
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(worker.WorkerFailure):
                worker.youtube_login_candidates("file", "", directory)

    def test_download_reuses_probed_cookiejar_without_reopening_browser(self):
        jar = YoutubeDLCookieJar()
        info = {"title": "Member", "format_id": "18", "ext": "mp4"}
        downloader = MagicMock()
        downloader.__enter__.return_value = downloader
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            media = output / "video.mp4"
            media.write_bytes(b"media fixture")
            with (
                patch.object(worker, "probe_youtube_session", return_value=(info, jar)) as probe,
                patch.object(worker, "switch_output_dir", return_value=output),
                patch.object(worker, "emit"),
                patch("yt_dlp.YoutubeDL", return_value=downloader) as factory,
            ):
                downloader.extract_info.return_value = info
                outcome = worker.download_media("https://youtu.be/test", output, "downloadOnly", "best")
            self.assertIs(downloader.cookiejar, jar)
            self.assertEqual(outcome.downloaded_media_path, media)
            self.assertEqual(probe.call_count, 1)
            self.assertNotIn("cookiesfrombrowser", factory.call_args.args[0])
            self.assertNotIn("cookiefile", factory.call_args.args[0])

    def test_cookie_file_is_read_only_and_unrelated_domains_are_removed(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "cookies.txt"
            file.write_text("# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tfixture\n.unrelated.test\tTRUE\t/\tFALSE\t0\tOTHER\tfixture\n", encoding="utf-8")
            original = file.read_bytes()
            downloader = MagicMock()
            downloader.__enter__.return_value = downloader
            downloader.extract_info.return_value = {"title": "Member"}
            with patch("yt_dlp.YoutubeDL", return_value=downloader) as factory:
                _, jar = worker.probe_youtube_session("https://youtu.be/test", {}, "file", "", directory)
            self.assertEqual([cookie.domain for cookie in jar], [".youtube.com"])
            self.assertEqual(file.read_bytes(), original)
            self.assertNotIn("cookiefile", factory.call_args.args[0])

    def test_split_video_audio_progress_is_weighted(self):
        tracker = worker.DownloadProgressTracker({"requested_formats": [
            {"format_id": "video", "filesize": 900}, {"format_id": "audio", "filesize": 100}
        ]})
        self.assertEqual(tracker.update({"status": "downloading", "info_dict": {"format_id": "video"}, "downloaded_bytes": 450, "total_bytes": 900}), 45)
        self.assertEqual(tracker.update({"status": "finished", "info_dict": {"format_id": "video"}}), 90)
        self.assertEqual(tracker.update({"status": "downloading", "info_dict": {"format_id": "audio"}, "downloaded_bytes": 50, "total_bytes": 100}), 95)
        self.assertEqual(tracker.update({"status": "finished", "info_dict": {"format_id": "audio"}}), 100)


if __name__ == "__main__":
    unittest.main()
