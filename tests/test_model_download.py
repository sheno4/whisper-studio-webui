import hashlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from python import model_download as models


class Response(io.BytesIO):
    def __init__(self, content, status=200, headers=None):
        super().__init__(content)
        self.status = status
        self.headers = headers or {"Content-Length": str(len(content))}


class ModelDownloadTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="whisper-model-fixture-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.target = self.root / "tiny.bin"
        self.events = []
        self.weights = b"actual streamed model fixture" * 7
        self.sha = hashlib.sha256(self.weights).hexdigest()

    def test_atomic_download_checksum_and_offline_verified_cache(self):
        calls = []

        def opener(url, headers):
            calls.append(headers)
            return Response(self.weights)

        result = models.verified_download("https://fixture/model", self.target, self.sha, self.events.append, opener=opener)
        self.assertEqual(result.read_bytes(), self.weights)
        self.assertTrue(models._verified(result, self.sha))
        self.assertEqual(calls, [{}])
        byte_events = [event for event in self.events if "downloadedBytes" in event]
        self.assertEqual(byte_events[-1]["downloadedBytes"], len(self.weights))
        self.assertEqual(byte_events[-1]["percent"], 100)
        models.verified_download("https://offline/model", self.target, self.sha, self.events.append, opener=lambda *_: self.fail("verified cache must not use network"))
        self.assertFalse(self.target.with_name("tiny.bin.partial").exists())

    def test_range_resume_uses_bytes_and_verifies_combined_digest(self):
        prefix = self.weights[:17]
        self.target.with_name("tiny.bin.partial").write_bytes(prefix)
        self.target.with_name("tiny.bin.partial.json").write_text(json.dumps({"sha256": self.sha}))

        def opener(url, headers):
            self.assertEqual(headers["Range"], "bytes=17-")
            return Response(self.weights[17:], 206, {"Content-Length": str(len(self.weights) - 17), "Content-Range": f"bytes 17-{len(self.weights) - 1}/{len(self.weights)}"})

        models.verified_download("https://fixture/model", self.target, self.sha, self.events.append, opener=opener)
        self.assertEqual(self.target.read_bytes(), self.weights)
        self.assertEqual(self.events[0]["downloadedBytes"], 17)

    def test_server_ignoring_range_restarts_without_duplicate_prefix(self):
        self.target.with_name("tiny.bin.partial").write_bytes(b"partial prefix")
        self.target.with_name("tiny.bin.partial.json").write_text(json.dumps({"sha256": self.sha}))
        models.verified_download("https://fixture/model", self.target, self.sha, self.events.append, opener=lambda *_: Response(self.weights))
        self.assertEqual(self.target.read_bytes(), self.weights)

    def test_bad_checksum_preserves_existing_model_and_removes_poisoned_partial(self):
        self.target.write_bytes(b"previous working model")
        calls = []

        def opener(*_):
            calls.append(1)
            return Response(b"wrong model")

        with self.assertRaises(models.ModelDownloadError) as failure:
            models.verified_download("https://fixture/model", self.target, self.sha, self.events.append, opener=opener)
        self.assertEqual(failure.exception.code, "MODEL_CHECKSUM_MISMATCH")
        self.assertEqual(self.target.read_bytes(), b"previous working model")
        self.assertEqual(len(calls), 1)
        self.assertFalse(self.target.with_name("tiny.bin.partial").exists())

    def test_incomplete_transfer_retains_recoverable_partial_and_is_bounded(self):
        calls = []

        def opener(*_):
            calls.append(1)
            return Response(b"first bytes", headers={"Content-Length": "999"})

        with patch.object(models.time, "sleep"), self.assertRaises(models.ModelDownloadError):
            models.verified_download("https://fixture/model", self.target, self.sha, self.events.append, opener=opener, retries=2)
        self.assertEqual(len(calls), 2)
        self.assertFalse(self.target.exists())
        self.assertEqual(self.target.with_name("tiny.bin.partial").read_bytes(), b"first bytes")

    def test_stale_lock_recovered_without_killing_an_owner(self):
        lock = self.root / "model.lock"
        lock.write_text(json.dumps({"pid": 1234, "token": "previous"}))
        with patch.object(models, "_process_alive", return_value=False), patch.object(models.os, "kill", side_effect=AssertionError("must not signal an owner")):
            with models.cache_lock(lock, self.events.append):
                self.assertEqual(json.loads(lock.read_text())["pid"], os.getpid())
        self.assertFalse(lock.exists())

    def test_cpp_uses_publisher_sha_and_verified_cache_without_metadata_refetch(self):
        target = self.root / "ggml-tiny.bin"
        metadata = json.dumps([{"path": target.name, "lfs": {"oid": self.sha}}]).encode()
        with patch.dict(os.environ, {"WHISPER_CPP_MODEL_DIR": str(self.root)}), patch.object(models, "_open", return_value=Response(metadata)) as request:
            with patch.object(models, "verified_download") as download:
                download.return_value = target
                result = models.download_model("whisper.cpp", "tiny", self.root, self.events.append)
                self.assertEqual(result, target)
                self.assertEqual(download.call_args.args[2], self.sha)
                self.assertEqual(request.call_count, 1)
        target.write_bytes(self.weights)
        models._save_marker(target, self.sha)
        with patch.dict(os.environ, {"WHISPER_CPP_MODEL_DIR": str(self.root)}), patch.object(models, "_open", side_effect=AssertionError("cached model should work offline")):
            self.assertEqual(models.download_model("whisper.cpp", "tiny", self.root, self.events.append), target)

    def test_model_map_reads_installed_metadata_without_importing_engine(self):
        package = self.root / "package"
        package.mkdir()
        (package / "__init__.py").write_text("raise AssertionError('should not import inference')")
        (package / "utils.py").write_text("_MODELS = {'tiny': 'publisher/tiny'}")
        with patch.object(models.importlib.util, "find_spec", return_value=SimpleNamespace(origin=str(package / "__init__.py"))):
            self.assertEqual(models._model_map("faster_whisper", "utils.py"), {"tiny": "publisher/tiny"})

    def test_faster_download_forwards_hub_byte_progress_without_loading_inference(self):
        try:
            import huggingface_hub
            from huggingface_hub import constants
        except ImportError:
            self.skipTest("Hugging Face is optional for the native backend")

        folder = self.root / "hub-snapshot"
        folder.mkdir()
        (folder / "model.bin").write_bytes(self.weights)
        (folder / "config.json").write_text("{}")
        calls = []

        def snapshot(repository, **options):
            calls.append(options)
            if options.get("local_files_only"):
                raise FileNotFoundError("no complete snapshot")
            bar = options["tqdm_class"](total=50, initial=0, unit="B", desc="model.bin")
            try:
                bar.n = 25
                bar._last_event = 0
                bar.display()
            finally:
                bar.close()
            return str(folder)

        with patch.object(models, "_model_map", return_value={"tiny": "publisher/tiny"}), patch.object(constants, "HF_HUB_CACHE", str(self.root / "hub")), patch.object(huggingface_hub, "snapshot_download", side_effect=snapshot):
            result = models.download_model("faster-whisper", "tiny", self.root, self.events.append)
        self.assertEqual(result, folder)
        self.assertEqual(calls[-1]["max_workers"], 4)
        self.assertTrue(any(event.get("downloadedBytes") == 25 and event.get("percent") == 50 for event in self.events))


if __name__ == "__main__":
    unittest.main()
