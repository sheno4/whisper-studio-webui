import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from python import worker


class WorkerReliabilityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.events = []
        for mocked in (
            patch.object(worker, "emit", side_effect=self.events.append),
            patch.object(worker, "log"),
            patch.object(worker, "LOG_FILE", None),
        ):
            mocked.start()
            self.addCleanup(mocked.stop)

    def test_invidious_retries_next_instance_after_directory_rename(self) -> None:
        metadata = {
            "title": "Recovered title",
            "lengthSeconds": 2,
            "adaptiveFormats": [{"type": "audio/mp4", "container": "m4a", "url": "https://media.invalid/audio"}],
        }
        downloads = []

        def download(**kwargs):
            downloads.append(kwargs["instance_uri"])
            if len(downloads) == 1:
                raise ConnectionError("first instance stream failed")
            kwargs["target_path"].write_bytes(b"audio fixture")
            return 13

        with tempfile.TemporaryDirectory() as temporary:
            pending = Path(temporary) / "pending"
            pending.mkdir()
            with (
                patch.object(worker, "get_invidious_instance_uris", return_value=["https://first.invalid", "https://second.invalid"]),
                patch.object(worker, "fetch_invidious_video_metadata", return_value=metadata),
                patch.object(worker, "download_invidious_stream", side_effect=download),
            ):
                outcome = worker.download_youtube_via_invidious(
                    "https://www.youtube.com/watch?v=abcdefghijk", pending, "transcribe", "best"
                )
            self.assertEqual(downloads, ["https://first.invalid", "https://second.invalid"])
            self.assertEqual(outcome.output_dir, Path(temporary) / "Recovered title")
            self.assertTrue(outcome.transcript_input_path.is_file())

    def test_douyin_failed_share_download_keeps_directory_for_browser_fallback(self) -> None:
        share_data = {"loaderData": {"video": {"videoInfoRes": {"item_list": [{
            "desc": "Douyin title", "video": {"duration": 2000, "play_addr": {
                "url_list": ["https://v26-web.douyinvod.com/media.mp4"]
            }}
        }]}}}}
        share_response = SimpleNamespace(
            text="<script>window._ROUTER_DATA=" + json.dumps(share_data) + "</script>",
            raise_for_status=lambda: None,
        )
        expected = object()
        fallback_directories_exist = []

        def browser_fallback(url, output_dir, behavior, quality):
            fallback_directories_exist.append(output_dir.is_dir())
            return expected

        with tempfile.TemporaryDirectory() as temporary:
            pending = Path(temporary) / "pending"
            pending.mkdir()
            with (
                patch("requests.get", side_effect=[share_response, ConnectionError("media stream failed")]),
                patch.object(worker, "download_douyin_via_browser", side_effect=browser_fallback) as fallback,
            ):
                outcome = worker.download_media(
                    "https://www.douyin.com/video/123456789012", pending, "transcribe", "best"
                )
            self.assertIs(outcome, expected)
            fallback.assert_called_once()
            self.assertEqual(fallback_directories_exist, [True])
            self.assertTrue(pending.is_dir())

    def test_douyin_success_relocates_all_returned_media_paths(self) -> None:
        for behavior in ("transcribe", "downloadOnly", "downloadThenTranscribe"):
            for quality in ("best", "audio"):
                with self.subTest(behavior=behavior, quality=quality), tempfile.TemporaryDirectory() as temporary:
                    pending = Path(temporary) / "pending"
                    pending.mkdir()
                    response = MagicMock()
                    response.__enter__.return_value = response
                    response.headers = {"content-length": "13"}
                    response.iter_content.return_value = [b"media fixture"]

                    def extract_audio(input_path, output_dir, display_name, **kwargs):
                        audio_path = output_dir / "converted.mp3"
                        audio_path.write_bytes(b"audio fixture")
                        return audio_path

                    with (
                        patch("requests.get", return_value=response),
                        patch.object(worker, "extract_audio_from_video", side_effect=extract_audio),
                    ):
                        outcome = worker.download_douyin_media_url(
                            play_url="https://v26-web.douyinvod.com/media.mp4",
                            video_id="123456789012", raw_title="Douyin title", output_dir=pending,
                            download_behavior=behavior, video_quality=quality, extractor="douyin-mobile-share",
                            webpage_url="https://www.douyin.com/video/123456789012", duration=2, request_headers={},
                        )
                    self.assertEqual(outcome.output_dir, Path(temporary) / "Douyin title")
                    self.assertFalse(pending.exists())
                    for media_path in (
                        outcome.transcript_input_path, outcome.temp_audio_path,
                        outcome.downloaded_media_path, outcome.source_media_path,
                    ):
                        if media_path is not None:
                            self.assertTrue(Path(media_path).is_file(), str(media_path))
                            self.assertEqual(Path(media_path).parent, outcome.output_dir)

    def test_link_source_location_is_valid_when_audio_is_removed_or_kept(self) -> None:
        for keep_audio in (False, True):
            with self.subTest(keep_audio=keep_audio), tempfile.TemporaryDirectory() as temporary:
                output_dir = Path(temporary) / "task"

                def download(url, output, behavior, quality, project, cookie_source="auto", browser_profile="", download_connections=8):
                    audio = output / "audio.m4a"
                    audio.write_bytes(b"audio fixture")
                    return worker.prepare_download_outcome_from_media(
                        output_dir=output, display_name="fixture", info={}, downloaded_file=audio,
                        download_behavior=behavior, video_quality=quality,
                    )

                request = {
                    "taskId": "audit-source-location", "sourceType": "link", "input": "https://media.invalid/audio",
                    "outputDir": str(output_dir), "downloadBehavior": "transcribe", "videoQuality": "best",
                    "whisperModel": "fixture", "keepAudio": keep_audio,
                }
                with (
                    patch.object(worker, "download_media", side_effect=download),
                    patch.object(worker, "stage_transcription_input", side_effect=lambda source, task_id: (source, None)),
                    patch.object(worker, "transcribe_audio", return_value={"text": "test", "language": "en", "segments": []}),
                ):
                    worker.process_task(request)
                result = [event["data"] for event in self.events if event["type"] == "result"][-1]
                source_path = Path(result["outputFiles"]["sourceMedia"])
                self.assertTrue(source_path.exists())
                self.assertEqual(source_path, output_dir / "audio.m4a" if keep_audio else output_dir)
                self.assertEqual("audio" in result["outputFiles"], keep_audio)


if __name__ == "__main__":
    unittest.main()
