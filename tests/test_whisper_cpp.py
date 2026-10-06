import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from python import whisper_cpp_backend as cpp
from python import worker


PAYLOAD = {
    "result": {"language": "zh"},
    "transcription": [
        {"offsets": {"from": 1250, "to": 2500}, "text": "  你好世界  "},
        {"offsets": {"from": 2500, "to": 4000}, "text": "测试字幕"},
    ],
}


class WhisperCppTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="whisper-cpp-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.executable = self.root / "whisper-cli"
        self.executable.write_bytes(b"CLI fixture")
        self.models = self.root / "models"
        self.models.mkdir()
        (self.models / "ggml-tiny.bin").write_bytes(b"model fixture")
        self.audio = self.root / "source.wav"
        self.audio.write_bytes(b"source fixture")
        self.environment = patch.dict(os.environ, {
            "WHISPER_CPP_PATH": str(self.executable),
            "WHISPER_CPP_MODEL_DIR": str(self.models), "WHISPER_DEVICE": "",
        })
        self.environment.start()
        self.addCleanup(self.environment.stop)

    @staticmethod
    def convert(command, **_):
        Path(command[-1]).write_bytes(b"converted PCM fixture")
        return SimpleNamespace(returncode=0, stderr="")

    @staticmethod
    def write_result(command):
        result_path = Path(command[command.index("-of") + 1] + ".json")
        result_path.write_text(json.dumps(PAYLOAD, ensure_ascii=False), encoding="utf-8")
        return result_path

    def test_native_timestamps_and_unicode_use_existing_exports(self):
        events = []
        commands = []

        def run_cli(command, *_):
            commands.append(command)
            self.write_result(command)
            return 0, ""

        request = {
            "taskId": "cpp-fixture", "sourceType": "file", "input": str(self.audio),
            "displayName": "原生字幕", "outputDir": str(self.root / "output"),
            "phase": "transcribe", "whisperModel": "tiny", "transcriptionEngine": "whisper.cpp",
            "transcriptionLanguage": "zh", "keepAudio": True,
            "preparedMedia": {"transcriptInputPath": str(self.audio), "mediaInfo": {"extractor": "fixture"}},
        }
        with (
            patch.object(cpp.shutil, "which", side_effect=lambda command: "ffmpeg-fixture" if command == "ffmpeg" else None),
            patch.object(cpp.subprocess, "run", side_effect=self.convert),
            patch.object(cpp, "_run_cli", side_effect=run_cli),
            patch.object(worker, "emit", side_effect=events.append),
            patch.object(worker, "LOG_FILE", None),
            patch.object(worker, "stage_transcription_input", return_value=(self.audio, None)),
        ):
            worker.process_task(request)
        result = [event["data"] for event in events if event["type"] == "result"][-1]
        self.assertEqual(result["language"], "zh")
        self.assertEqual(result["transcriptSegments"][0], {"id": 0, "start": 1.25, "end": 2.5, "text": "你好世界"})
        self.assertEqual(result["transcriptText"], "你好世界 测试字幕")
        files = result["outputFiles"]
        self.assertIn("你好世界", Path(files["transcriptTxt"]).read_text(encoding="utf-8"))
        self.assertIn("00:00:01,250 --> 00:00:02,500", Path(files["transcriptSrt"]).read_text(encoding="utf-8"))
        self.assertIn("00:00:01.250 --> 00:00:02.500", Path(files["transcriptVtt"]).read_text(encoding="utf-8"))
        metadata = json.loads(Path(files["metadataJson"]).read_text(encoding="utf-8"))
        self.assertEqual(metadata["segments"], result["transcriptSegments"])
        self.assertEqual(commands[0][commands[0].index("-l") + 1], "zh")
        self.assertTrue(self.audio.is_file())

    def test_gpu_failure_retries_once_without_using_partial_transcript(self):
        attempts = []
        warnings = []

        def run_cli(command, *_):
            attempts.append(command)
            result_path = Path(command[command.index("-of") + 1] + ".json")
            if len(attempts) == 1:
                result_path.write_text('{"partial":true}', encoding="utf-8")
                return 3, "ggml_vulkan: VK_ERROR_OUT_OF_DEVICE_MEMORY"
            self.assertFalse(result_path.exists())
            self.assertIn("--no-gpu", command)
            self.write_result(command)
            return 0, ""

        with (
            patch.object(cpp.shutil, "which", side_effect=lambda command: "ffmpeg-fixture" if command == "ffmpeg" else None),
            patch.object(cpp.subprocess, "run", side_effect=self.convert),
            patch.object(cpp, "_run_cli", side_effect=run_cli),
        ):
            result = cpp.transcribe(self.audio, "tiny", log_callback=lambda level, message: warnings.append((level, message)))
        self.assertEqual(len(attempts), 2)
        self.assertNotIn("--no-gpu", attempts[0])
        self.assertEqual(result["text"], "你好世界 测试字幕")
        self.assertTrue(any(level == "warning" for level, _ in warnings))

    def test_cpu_request_does_not_retry_and_non_gpu_errors_do_not_retry(self):
        for device, error in [("cpu", "Vulkan error fixture"), ("", "invalid model header")]:
            with (
                self.subTest(device=device),
                patch.dict(os.environ, {"WHISPER_DEVICE": device}),
                patch.object(cpp.shutil, "which", side_effect=lambda command: "ffmpeg-fixture" if command == "ffmpeg" else None),
                patch.object(cpp.subprocess, "run", side_effect=self.convert),
                patch.object(cpp, "_run_cli", return_value=(3, error)) as run,
            ):
                with self.assertRaises(cpp.WhisperCppFailure) as failure:
                    cpp.transcribe(self.audio, "tiny")
                self.assertEqual(failure.exception.code, "whisper_cpp_error")
                self.assertEqual(run.call_count, 1)
                self.assertEqual("--no-gpu" in run.call_args.args[0], device == "cpu")

    def test_missing_or_incompatible_model_fails_before_audio_conversion(self):
        self.assertEqual(cpp.model_path("turbo"), self.models / "ggml-large-v3-turbo.bin")
        self.assertEqual(cpp.resolve_model_name("large"), "large-v3")
        for model, expected in [("base", "whisper_cpp_model_missing"), ("distil-large-v3", "whisper_cpp_model_unsupported")]:
            with self.subTest(model=model), patch.object(cpp.subprocess, "run") as run:
                with self.assertRaises(cpp.WhisperCppFailure) as failure:
                    cpp.transcribe(self.audio, model)
                self.assertEqual(failure.exception.code, expected)
                run.assert_not_called()

    def test_invalid_native_json_is_a_structured_failure(self):
        invalid = [
            {"transcription": None},
            {"transcription": [None]},
            {"transcription": [{"text": "x", "offsets": {"from": -1, "to": 2}}]},
            {"transcription": [{"text": "x", "offsets": {"from": 2, "to": 1}}]},
            {"transcription": [{"text": "x", "offsets": {"from": 0, "to": float("nan")}}]},
            {"transcription": [], "result": "invalid"},
        ]
        for payload in invalid:
            with self.subTest(payload=payload), self.assertRaises(cpp.WhisperCppFailure) as failure:
                cpp.parse_result(payload, None)
            self.assertEqual(failure.exception.code, "whisper_cpp_output_invalid")

    def test_stderr_help_is_valid_and_model_is_checked_independently(self):
        with patch.object(cpp.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout="", stderr="usage: whisper-cli")):
            result = cpp.inspect_runtime(model_name="tiny")
            missing = cpp.inspect_runtime(model_name="base")
        self.assertTrue(result["whisperCppOk"])
        self.assertTrue(result["whisperCppModelOk"])
        self.assertTrue(missing["whisperCppOk"])
        self.assertFalse(missing["whisperCppModelOk"])

    def test_cli_stream_routes_progress_and_logs_without_detaching_children(self):
        events = []
        fake_process = SimpleNamespace(stdout=io.StringIO("ggml_vulkan: using GPU\nwhisper_print_progress_callback: progress = 50%\n"), wait=lambda: 0)
        class ProcessContext:
            def __enter__(self):
                return fake_process

            def __exit__(self, *_):
                return False

        with patch.object(cpp.subprocess, "Popen", return_value=ProcessContext()) as spawn:
            code, details = cpp._run_cli([str(self.executable)], self.executable,
                lambda message, percent: events.append(("progress", percent)),
                lambda level, message: events.append((level, message)))
        self.assertEqual(code, 0)
        self.assertIn(("progress", 42.5), events)
        self.assertIn("ggml_vulkan", details)
        self.assertNotIn("start_new_session", spawn.call_args.kwargs)
        self.assertNotIn("creationflags", spawn.call_args.kwargs)


class CpuBackendTests(unittest.TestCase):
    def test_cpu_override_prevents_old_faster_whisper_from_querying_or_using_cuda(self):
        module = SimpleNamespace(download_model=lambda _: "fixture-model")
        with (
            patch.dict(os.environ, {"WHISPER_DEVICE": "cpu"}),
            patch.dict(sys.modules, {"faster_whisper.utils": module}),
            patch.object(worker, "configure_faster_whisper_cuda_runtime"),
            patch.object(worker, "query_nvidia_gpu_total_memory_mb") as query,
            patch.object(worker, "probe_media_duration_seconds", return_value=None),
            patch.object(worker, "progress"), patch.object(worker, "log"),
            patch.object(worker, "transcribe_with_faster_whisper_candidate", return_value={"text": "cpu"}) as transcribe,
        ):
            result = worker.transcribe_with_faster_whisper(Path("fixture.wav"), "tiny", None)
        query.assert_not_called()
        self.assertEqual(transcribe.call_args.args[3:5], ("cpu", "int8"))
        self.assertEqual(result["text"], "cpu")

    def test_cpu_override_uses_a_separate_openai_whisper_model_cache(self):
        loaded = []
        model = SimpleNamespace(device="cpu", transcribe=lambda *_args, **_kwargs: {"text": "cpu"})
        fake_whisper = SimpleNamespace(load_model=lambda name, **kwargs: loaded.append((name, kwargs)) or model)
        fake_transcribe = SimpleNamespace(tqdm=SimpleNamespace(tqdm=object()))
        with (
            patch.dict(os.environ, {"WHISPER_DEVICE": "cpu"}),
            patch.dict(sys.modules, {"whisper": fake_whisper, "whisper.transcribe": fake_transcribe}),
            patch.object(worker, "OPENAI_WHISPER_MODEL_CACHE", {"tiny:auto": SimpleNamespace(device="cuda")}),
            patch.object(worker, "create_transcription_tqdm", return_value=object()),
            patch.object(worker, "progress"), patch.object(worker, "log"),
        ):
            worker.transcribe_with_openai_whisper_optimized(Path("fixture.wav"), "tiny", None)
            worker.transcribe_with_openai_whisper_optimized(Path("fixture.wav"), "tiny", None)
        self.assertEqual(loaded, [("tiny", {"device": "cpu"})])


if __name__ == "__main__":
    unittest.main()
