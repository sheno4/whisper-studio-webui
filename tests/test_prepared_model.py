import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from python import worker


class PreparedModelTests(unittest.TestCase):
    def test_faster_transcription_uses_prepared_weights_without_contacting_hub(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("model.bin", "config.json"):
                (root / name).write_bytes(b"fixture")
            download = Mock(side_effect=AssertionError("Prepared models must not fetch Hub metadata again"))
            with (
                patch.dict(os.environ, {"WHISPER_DEVICE": "cpu"}),
                patch.dict(sys.modules, {"faster_whisper.utils": SimpleNamespace(download_model=download)}),
                patch.object(worker, "configure_faster_whisper_cuda_runtime"),
                patch.object(worker, "probe_media_duration_seconds", return_value=None),
                patch.object(worker, "progress"), patch.object(worker, "log"),
                patch.object(worker, "transcribe_with_faster_whisper_candidate", return_value={"text": "fixture"}) as transcribe,
            ):
                self.assertEqual(worker.transcribe_with_faster_whisper(Path("fixture.wav"), "tiny", None, str(root))["text"], "fixture")
            download.assert_not_called()
            self.assertEqual(transcribe.call_args.args[2], str(root))

    def test_openai_transcription_loads_prepared_file_and_reuses_inference_model(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "tiny.pt"
            target.write_bytes(b"fixture")
            model = SimpleNamespace(device="cpu", transcribe=lambda *_args, **_kwargs: {"text": "fixture"})
            load = Mock(return_value=model)
            with (
                patch.dict(os.environ, {"WHISPER_DEVICE": "cpu"}),
                patch.dict(sys.modules, {"whisper": SimpleNamespace(load_model=load), "whisper.transcribe": SimpleNamespace(tqdm=SimpleNamespace(tqdm=object()))}),
                patch.object(worker, "OPENAI_WHISPER_MODEL_CACHE", {}),
                patch.object(worker, "create_transcription_tqdm", return_value=object()),
                patch.object(worker, "progress"), patch.object(worker, "log"),
            ):
                for _ in range(2):
                    worker.transcribe_with_openai_whisper_optimized(Path("fixture.wav"), "tiny", None, str(target))
            load.assert_called_once_with(str(target), device="cpu")


if __name__ == "__main__":
    unittest.main()
