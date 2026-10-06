import unittest
from pathlib import Path
from unittest.mock import patch

from python.worker import (
    WorkerFailure,
    download_media,
    is_douyin_media_url,
    normalize_douyin_browser_title,
)


class DouyinWorkerTests(unittest.TestCase):
    def test_accepts_douyin_media_hosts(self) -> None:
        self.assertTrue(is_douyin_media_url("https://v26-web.douyinvod.com/path/video.mp4?token=1"))

    def test_rejects_lookalike_or_insecure_media_hosts(self) -> None:
        self.assertFalse(is_douyin_media_url("https://douyinvod.com.example.org/video.mp4"))
        self.assertFalse(is_douyin_media_url("http://v26-web.douyinvod.com/video.mp4"))

    def test_normalizes_douyin_page_title(self) -> None:
        self.assertEqual(normalize_douyin_browser_title("蛋黄到底能不能吃？ - 抖音"), "蛋黄到底能不能吃？")
        self.assertIsNone(normalize_douyin_browser_title("���Ƶ��� - 抖音"))

    def test_falls_back_to_isolated_browser_when_share_page_changes(self) -> None:
        expected = object()
        with (
            patch(
                "python.worker.download_douyin_via_share_page",
                side_effect=WorkerFailure("download_failed", "旧分享页没有视频条目"),
            ),
            patch("python.worker.download_douyin_via_browser", return_value=expected) as browser_fallback,
            patch("python.worker.log"),
        ):
            result = download_media(
                "https://v.douyin.com/Or7mQoN_pBM/",
                Path("unused"),
                "transcribe",
                "best",
            )

        self.assertIs(result, expected)
        browser_fallback.assert_called_once()


if __name__ == "__main__":
    unittest.main()
