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

    @staticmethod
    def downloader(info=None, error=None):
        downloader = MagicMock()
        downloader.__enter__.return_value = downloader
        downloader.extract_info.return_value = info or {"title": "Public", "format_id": "18", "ext": "mp4"}
        downloader.extract_info.side_effect = error
        return downloader

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

    def test_public_video_never_discovers_or_loads_auth_for_any_selected_source(self):
        for source in ("auto", "firefox", "chrome", "file", "none", "old-invalid-setting"):
            with self.subTest(source=source):
                downloader = self.downloader()
                with (
                    patch.object(worker, "youtube_login_candidates") as candidates,
                    patch("yt_dlp.cookies.load_cookies") as load_cookies,
                    patch.object(Path, "is_file", side_effect=AssertionError("cookie/profile lookup")),
                    patch("yt_dlp.YoutubeDL", return_value=downloader) as factory,
                ):
                    info, jar = worker.probe_youtube_session(
                        "https://youtu.be/test", {"cookiefile": "missing.txt", "cookiesfrombrowser": ("chrome",)},
                        source, "obsolete-profile", "missing-project",
                    )
                self.assertEqual(info["title"], "Public")
                self.assertIsNone(jar)
                candidates.assert_not_called()
                load_cookies.assert_not_called()
                self.assertNotIn("cookiefile", factory.call_args.args[0])
                self.assertNotIn("cookiesfrombrowser", factory.call_args.args[0])

    def test_failed_profile_tries_next_after_anonymous_access_gate(self):
        anonymous = self.downloader(error=RuntimeError("membership required"))
        first = self.downloader(error=RuntimeError("membership required"))
        second = self.downloader({"title": "Member video"})
        first_jar, second_jar = YoutubeDLCookieJar(), YoutubeDLCookieJar()
        with (
            patch.object(worker, "youtube_login_candidates", return_value=[
                ("Firefox", {"cookiesfrombrowser": ("firefox", None, None, None)}),
                ("Chrome", {"cookiesfrombrowser": ("chrome", None, None, None)}),
            ]) as candidates,
            patch("yt_dlp.YoutubeDL", side_effect=[anonymous, first, second]),
            patch("yt_dlp.cookies.load_cookies", side_effect=[first_jar, second_jar]) as load_cookies,
        ):
            info, jar = worker.probe_youtube_session("https://youtu.be/test", {}, "auto", "", "")
        self.assertEqual(info["title"], "Member video")
        self.assertIs(jar, second_jar)
        self.assertIs(second.cookiejar, second_jar)
        self.assertEqual(load_cookies.call_count, 2)
        candidates.assert_called_once_with("auto", "", "")

    def test_none_reports_actual_access_gate_without_reading_auth(self):
        for message, code in (
            ("This video is members-only", "membership_required"),
            ("Sign in to confirm your age", "youtube_age_restricted"),
            ("Sign in to confirm you’re not a bot", "youtube_bot_check"),
            ("Login required to watch this video", "auth_required"),
        ):
            with (
                self.subTest(message=message),
                patch.object(worker, "youtube_login_candidates") as candidates,
                patch("yt_dlp.cookies.load_cookies") as load_cookies,
                patch("yt_dlp.YoutubeDL", return_value=self.downloader(error=RuntimeError(message))),
            ):
                with self.assertRaises(worker.WorkerFailure) as raised:
                    worker.probe_youtube_session("https://youtu.be/test", {}, "none", "", "")
                self.assertEqual(raised.exception.code, code)
                self.assertIn(message, raised.exception.details)
                self.assertNotIn("失效", raised.exception.message)
                candidates.assert_not_called()
                load_cookies.assert_not_called()

    def test_non_auth_failures_keep_reason_and_do_not_load_auth(self):
        for message, code in (
            ("Connection timed out", "network_error"),
            ("HTTP Error 403: Forbidden", "youtube_access_blocked"),
            ("Requested format is not available", "format_unavailable"),
            ("Unable to extract player response; cookies might help", "youtube_extract_failed"),
            ("ffmpeg not found", "ffmpeg_missing"),
            ("Unrecognized bot response", "youtube_extract_failed"),
        ):
            with (
                self.subTest(message=message),
                patch.object(worker, "youtube_login_candidates") as candidates,
                patch("yt_dlp.cookies.load_cookies") as load_cookies,
                patch("yt_dlp.YoutubeDL", return_value=self.downloader(error=RuntimeError(message))),
            ):
                with self.assertRaises(worker.WorkerFailure) as raised:
                    worker.probe_youtube_session("https://youtu.be/test", {}, "auto", "", "")
                self.assertEqual(raised.exception.code, code)
                self.assertEqual(raised.exception.details, message)
                self.assertNotIn("会员", raised.exception.message)
                candidates.assert_not_called()
                load_cookies.assert_not_called()

    def test_network_failure_after_real_gate_does_not_try_more_accounts(self):
        anonymous = self.downloader(error=RuntimeError("This video is members-only"))
        authenticated = self.downloader(error=TimeoutError("network request timed out"))
        with (
            patch.object(worker, "youtube_login_candidates", return_value=[("Firefox", {}), ("Chrome", {})]),
            patch("yt_dlp.YoutubeDL", side_effect=[anonymous, authenticated]),
            patch("yt_dlp.cookies.load_cookies", return_value=YoutubeDLCookieJar()) as load_cookies,
        ):
            with self.assertRaises(worker.WorkerFailure) as raised:
                worker.probe_youtube_session("https://youtu.be/test", {}, "auto", "", "")
        self.assertEqual(raised.exception.code, "network_error")
        self.assertIn("network request timed out", raised.exception.details)
        load_cookies.assert_called_once()

    def test_cookie_load_failure_preserves_wrapped_cause(self):
        from yt_dlp.cookies import CookieLoadError

        try:
            try:
                raise PermissionError("cookies.sqlite is locked")
            except PermissionError:
                raise CookieLoadError("failed to load cookies")
        except CookieLoadError as error:
            cookie_error = error
        with (
            patch.object(worker, "youtube_login_candidates", return_value=[("Firefox", {})]),
            patch("yt_dlp.YoutubeDL", side_effect=[
                self.downloader(error=RuntimeError("This video is members-only")), self.downloader(),
            ]),
            patch("yt_dlp.cookies.load_cookies", side_effect=cookie_error),
        ):
            with self.assertRaises(worker.WorkerFailure) as raised:
                worker.probe_youtube_session("https://youtu.be/test", {}, "firefox", "", "")
        self.assertEqual(raised.exception.code, "youtube_cookies_unavailable")
        self.assertIn("failed to load cookies", raised.exception.details)
        self.assertIn("cookies.sqlite is locked", raised.exception.details)

    def test_member_failure_never_uses_anonymous_mirror(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(worker, "probe_youtube_session", side_effect=worker.WorkerFailure("membership_required", "member required")),
            patch.object(worker, "download_youtube_via_invidious") as mirror,
            patch.object(worker, "emit"),
        ):
            with self.assertRaises(worker.WorkerFailure):
                worker.download_media("https://youtu.be/test", Path(directory), "downloadOnly", "best")
            mirror.assert_not_called()

    def test_explicit_source_and_missing_cookie_file(self):
        candidates = worker.youtube_login_candidates("chrome", "Profile 2", "")
        self.assertEqual(candidates, [("Chrome", {"cookiesfrombrowser": ("chrome", "Profile 2", None, None)})])
        self.assertEqual(worker.youtube_login_candidates("none", "", ""), [])
        with tempfile.TemporaryDirectory() as directory:
            with patch("yt_dlp.YoutubeDL", return_value=self.downloader(error=RuntimeError("Sign in to watch"))):
                with self.assertRaises(worker.WorkerFailure) as raised:
                    worker.probe_youtube_session("https://youtu.be/test", {}, "file", "", directory)
            self.assertEqual(raised.exception.code, "youtube_cookies_missing")
            self.assertIn("Sign in to watch", raised.exception.details)

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
                patch("yt_dlp.cookies.load_cookies") as load_cookies,
            ):
                downloader.extract_info.return_value = info
                outcome = worker.download_media("https://youtu.be/test", output, "downloadOnly", "best")
            self.assertIs(downloader.cookiejar, jar)
            self.assertEqual(outcome.downloaded_media_path, media)
            self.assertEqual(probe.call_count, 1)
            load_cookies.assert_not_called()
            self.assertNotIn("cookiesfrombrowser", factory.call_args.args[0])
            self.assertNotIn("cookiefile", factory.call_args.args[0])

    def test_cookie_file_is_read_only_and_unrelated_domains_are_removed(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "cookies.txt"
            file.write_text("# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tfixture\n.unrelated.test\tTRUE\t/\tFALSE\t0\tOTHER\tfixture\n", encoding="utf-8")
            original = file.read_bytes()
            downloader = MagicMock()
            downloader.__enter__.return_value = downloader
            downloader.extract_info.side_effect = [RuntimeError("This video is members-only"), {"title": "Member"}]
            with patch("yt_dlp.YoutubeDL", return_value=downloader) as factory:
                _, jar = worker.probe_youtube_session("https://youtu.be/test", {}, "file", "", directory)
            self.assertEqual([cookie.domain for cookie in jar], [".youtube.com"])
            self.assertEqual(file.read_bytes(), original)
            self.assertNotIn("cookiefile", factory.call_args.args[0])

    def test_download_gate_authenticates_once_and_reuses_new_jar(self):
        info = {"title": "Member", "format_id": "18", "ext": "mp4"}
        jar = YoutubeDLCookieJar()
        initial = self.downloader(error=RuntimeError("This video is members-only"))
        authenticated = self.downloader(info)
        retry = self.downloader(info)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            media = output / "video.mp4"
            media.write_bytes(b"media fixture")
            with (
                patch.object(worker, "probe_youtube_session", return_value=(info, None)),
                patch.object(worker, "youtube_login_candidates", return_value=[("Firefox", {})]) as candidates,
                patch.object(worker, "switch_output_dir", return_value=output),
                patch.object(worker, "emit"),
                patch("yt_dlp.YoutubeDL", side_effect=[initial, authenticated, retry]) as factory,
                patch("yt_dlp.cookies.load_cookies", return_value=jar) as load_cookies,
                patch.object(worker, "download_youtube_via_invidious") as mirror,
            ):
                outcome = worker.download_media("https://youtu.be/test", output, "downloadOnly", "best")
            self.assertEqual(outcome.downloaded_media_path, media)
            self.assertIs(authenticated.cookiejar, jar)
            self.assertIs(retry.cookiejar, jar)
            self.assertEqual(factory.call_count, 3)
            candidates.assert_called_once()
            load_cookies.assert_called_once()
            mirror.assert_not_called()

    def test_download_second_gate_does_not_reload_auth(self):
        info = {"title": "Member", "format_id": "18", "ext": "mp4"}
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(worker, "probe_youtube_session", return_value=(info, None)),
            patch.object(worker, "youtube_login_candidates", return_value=[("Firefox", {})]) as candidates,
            patch.object(worker, "switch_output_dir", side_effect=lambda output, title: output),
            patch.object(worker, "emit"),
            patch("yt_dlp.YoutubeDL", side_effect=[
                self.downloader(error=RuntimeError("This video is members-only")), self.downloader(info),
                self.downloader(error=RuntimeError("This video is members-only")),
            ]),
            patch("yt_dlp.cookies.load_cookies", return_value=YoutubeDLCookieJar()) as load_cookies,
        ):
            with self.assertRaises(worker.WorkerFailure) as raised:
                worker.download_media("https://youtu.be/test", Path(directory), "downloadOnly", "best")
        self.assertEqual(raised.exception.code, "membership_required")
        candidates.assert_called_once()
        load_cookies.assert_called_once()

    def test_download_none_does_not_read_auth_or_report_session_expired(self):
        info = {"title": "Public", "format_id": "18", "ext": "mp4"}
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(worker, "probe_youtube_session", return_value=(info, None)),
            patch.object(worker, "youtube_login_candidates") as candidates,
            patch.object(worker, "switch_output_dir", side_effect=lambda output, title: output),
            patch.object(worker, "emit"),
            patch("yt_dlp.YoutubeDL", return_value=self.downloader(error=RuntimeError("Sign in to confirm your age"))),
            patch("yt_dlp.cookies.load_cookies") as load_cookies,
        ):
            with self.assertRaises(worker.WorkerFailure) as raised:
                worker.download_media("https://youtu.be/test", Path(directory), "downloadOnly", "best", youtube_cookie_source="none")
        self.assertEqual(raised.exception.code, "youtube_age_restricted")
        self.assertNotIn("失效", raised.exception.message)
        candidates.assert_not_called()
        load_cookies.assert_not_called()

    def test_preview_network_failure_can_still_download_anonymously(self):
        for behavior in ("transcribe", "downloadOnly", "downloadThenTranscribe"):
            with self.subTest(behavior=behavior), tempfile.TemporaryDirectory() as directory:
                output = Path(directory)
                (output / "video.mp4").write_bytes(b"media fixture")
                expected = object()
                with (
                    patch.object(worker, "probe_youtube_session", side_effect=worker.WorkerFailure("network_error", "timed out")),
                    patch.object(worker, "youtube_login_candidates") as candidates,
                    patch.object(worker, "switch_output_dir", return_value=output),
                    patch.object(worker, "prepare_download_outcome_from_media", return_value=expected) as prepare,
                    patch.object(worker, "emit"),
                    patch("yt_dlp.YoutubeDL", return_value=self.downloader()) as factory,
                    patch("yt_dlp.cookies.load_cookies") as load_cookies,
                    patch.object(worker, "download_youtube_via_invidious") as mirror,
                ):
                    actual = worker.download_media("https://youtu.be/test", output, behavior, "best")
                self.assertIs(actual, expected)
                self.assertEqual(prepare.call_args.kwargs["download_behavior"], behavior)
                self.assertEqual(factory.call_args.args[0]["download_connections"], 8)
                candidates.assert_not_called()
                load_cookies.assert_not_called()
                mirror.assert_not_called()

    def test_download_generic_403_keeps_details_and_never_reads_auth(self):
        info = {"title": "Public", "format_id": "18", "ext": "mp4"}
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(worker, "probe_youtube_session", return_value=(info, None)),
            patch.object(worker, "youtube_login_candidates") as candidates,
            patch.object(worker, "switch_output_dir", side_effect=lambda output, title: output),
            patch.object(worker, "emit"),
            patch("yt_dlp.YoutubeDL", return_value=self.downloader(error=RuntimeError("HTTP Error 403: Forbidden"))),
            patch("yt_dlp.cookies.load_cookies") as load_cookies,
        ):
            with self.assertRaises(worker.WorkerFailure) as raised:
                worker.download_media("https://youtu.be/test", Path(directory), "downloadOnly", "best")
        self.assertEqual(raised.exception.code, "youtube_access_blocked")
        self.assertEqual(raised.exception.details, "HTTP Error 403: Forbidden")
        self.assertNotIn("会员", raised.exception.message)
        candidates.assert_not_called()
        load_cookies.assert_not_called()

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
