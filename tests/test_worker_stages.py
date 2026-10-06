import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from python import worker


class WorkerStageTests(unittest.TestCase):
    def test_prepare_does_not_transcribe_and_transcribe_reuses_media_and_log(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            audio = root / "source.wav"
            audio.write_bytes(b"audio fixture")
            request = {
                "taskId": "stage-fixture", "sourceType": "file", "input": str(audio),
                "displayName": "Sample", "outputDir": str(root / "pending"), "phase": "prepare",
                "whisperModel": "tiny", "transcriptionEngine": "whisper", "keepAudio": True,
            }
            events = []
            with (
                patch.object(worker, "emit", side_effect=events.append),
                patch.object(worker, "transcribe_audio", return_value={"text": "hello", "language": "en", "segments": []}) as transcribe,
                patch.object(worker, "stage_transcription_input", return_value=(audio, None)),
                patch.object(worker, "prepare_local_media", wraps=worker.prepare_local_media) as prepare,
            ):
                worker.process_task(request)
                transcribe.assert_not_called()
                prepared = [event["data"] for event in events if event["type"] == "result"][-1]
                self.assertEqual(prepared["preparedMedia"]["transcriptInputPath"], str(audio))
                log = Path(prepared["outputFiles"]["logFile"])
                with log.open("a", encoding="utf-8") as stream:
                    stream.write("prepare log sentinel\n")
                events.clear()
                worker.process_task({**request, "phase": "transcribe", "outputDir": prepared["outputDir"],
                    "displayName": prepared["displayName"], "preparedMedia": prepared["preparedMedia"]})
                self.assertEqual(prepare.call_count, 1)
                transcribe.assert_called_once()
                final = [event["data"] for event in events if event["type"] == "result"][-1]
                self.assertEqual(final["transcriptText"], "hello")
                self.assertIn("prepare log sentinel", Path(final["outputFiles"]["logFile"]).read_text(encoding="utf-8"))
                self.assertTrue(Path(final["outputFiles"]["transcriptTxt"]).is_file())
                self.assertTrue(audio.is_file())

    def test_directory_collision_retries_without_touching_existing_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pending = root / "pending"
            pending.mkdir()
            (pending / "ours.txt").write_text("ours", encoding="utf-8")
            original_rename = Path.rename
            collided = False

            def rename(source, destination):
                nonlocal collided
                if not collided:
                    collided = True
                    destination.mkdir()
                    (destination / "existing.txt").write_text("existing", encoding="utf-8")
                    raise FileExistsError("concurrent reservation")
                return original_rename(source, destination)

            with patch.object(Path, "rename", rename), patch.object(worker, "emit"), patch.object(worker, "LOG_FILE", None):
                output = worker.switch_output_dir(pending, "Shared")
            self.assertEqual(output.name, "Shared (2)")
            self.assertEqual((output / "ours.txt").read_text(encoding="utf-8"), "ours")
            self.assertEqual((root / "Shared" / "existing.txt").read_text(encoding="utf-8"), "existing")


if __name__ == "__main__":
    unittest.main()
