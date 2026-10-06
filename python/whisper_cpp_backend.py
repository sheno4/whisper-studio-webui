"""The whisper.cpp CLI backend, independent of PyTorch and CTranslate2."""
from __future__ import annotations

import json
import math
import os
import re
import shutil
import subprocess
import tempfile
from collections import deque
from pathlib import Path
from typing import Any, Callable


MODEL_NAMES = frozenset({
    "tiny", "tiny.en", "base", "base.en", "small", "small.en",
    "medium", "medium.en", "large-v1", "large-v2", "large-v3", "large-v3-turbo",
})
MODEL_ALIASES = {"large": "large-v3", "turbo": "large-v3-turbo"}
GPU_FAILURE = re.compile(
    r"(?:vulkan|metal|cuda|cublas|gpu|device).*(?:fail|error|unavailable|not found|out of memory)"
    r"|(?:fail|error|no compatible).*?(?:vulkan|metal|cuda|cublas|gpu|device)"
    r"|vk_error|cuda_error|out of (?:device|gpu) memory",
    re.IGNORECASE,
)
PROGRESS_PATTERN = re.compile(r"\bprogress\s*=\s*(\d+(?:\.\d+)?)\s*%", re.IGNORECASE)


class WhisperCppFailure(RuntimeError):
    def __init__(self, code: str, message: str, details: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details


def project_directory(project_root: Path | str | None = None) -> Path:
    return Path(project_root) if project_root else Path(__file__).resolve().parent.parent


def resolve_model_name(model_name: str) -> str:
    name = MODEL_ALIASES.get(model_name.strip(), model_name.strip())
    if name not in MODEL_NAMES:
        raise WhisperCppFailure(
            "whisper_cpp_model_unsupported",
            f"whisper.cpp 不支持此模型：{model_name}。请在设置中选择受支持的 GGML 模型。",
        )
    return name


def cli_path(project_root: Path | str | None = None) -> Path:
    configured = os.environ.get("WHISPER_CPP_PATH", "").strip()
    if configured:
        return Path(shutil.which(configured) or configured)
    executable = "whisper-cli.exe" if os.name == "nt" else "whisper-cli"
    return project_directory(project_root) / ".runtime" / "whisper-cpp" / "bin" / executable


def model_path(model_name: str, project_root: Path | str | None = None) -> Path:
    configured = os.environ.get("WHISPER_CPP_MODEL_DIR", "").strip()
    directory = Path(configured) if configured else (
        project_directory(project_root) / ".runtime" / "models" / "whisper-cpp"
    )
    return directory / f"ggml-{resolve_model_name(model_name)}.bin"


def cli_environment(executable: Path) -> dict[str, str]:
    environment = os.environ.copy()
    # Packaged shared libraries live alongside the CLI. Changes affect only
    # this child process, including Linux bundles without an absolute rpath.
    directory = str(executable.resolve().parent)
    environment["PATH"] = directory + os.pathsep + environment.get("PATH", "")
    if os.name != "nt":
        environment["LD_LIBRARY_PATH"] = directory + os.pathsep + environment.get("LD_LIBRARY_PATH", "")
    return environment


def inspect_runtime(
    project_root: Path | str | None = None, model_name: str | None = None,
) -> dict[str, Any]:
    executable = cli_path(project_root)
    result: dict[str, Any] = {"whisperCppOk": False, "whisperCppPath": str(executable)}
    try:
        probe = subprocess.run(
            [str(executable), "--help"], stdin=subprocess.DEVNULL,
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=10, env=cli_environment(executable),
        )
        result["whisperCppOk"] = probe.returncode == 0
        if probe.returncode != 0:
            result["whisperCppError"] = (probe.stderr or probe.stdout).strip()[-4000:] or (
                f"whisper-cli exited with code {probe.returncode}."
            )
    except (OSError, subprocess.TimeoutExpired) as error:
        result["whisperCppError"] = str(error)
    if model_name:
        try:
            model = model_path(model_name, project_root)
            result["whisperCppModelPath"] = str(model)
            result["whisperCppModelOk"] = model.is_file() and model.stat().st_size > 0
        except WhisperCppFailure as error:
            result["whisperCppModelOk"] = False
            result["whisperCppModelError"] = error.message
    return result


def parse_result(payload: dict[str, Any], requested_language: str | None) -> dict[str, Any]:
    transcription = payload.get("transcription")
    if not isinstance(transcription, list):
        raise WhisperCppFailure("whisper_cpp_output_invalid", "whisper.cpp 未返回有效的转写段落。")
    segments: list[dict[str, Any]] = []
    for entry in transcription:
        try:
            if not isinstance(entry, dict) or not isinstance(entry.get("text"), str):
                raise ValueError("invalid segment text")
            offsets = entry["offsets"]
            start = float(offsets["from"]) / 1000.0
            end = float(offsets["to"]) / 1000.0
            if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end < start:
                raise ValueError("invalid segment timestamps")
        except (KeyError, TypeError, ValueError) as error:
            raise WhisperCppFailure(
                "whisper_cpp_output_invalid", "whisper.cpp 返回的段落时间无效。", str(error),
            ) from error
        segments.append({
            "id": len(segments), "start": start, "end": end,
            "text": str(entry.get("text") or "").strip(),
        })
    result = payload.get("result") or {}
    if not isinstance(result, dict) or (result.get("language") is not None and not isinstance(result["language"], str)):
        raise WhisperCppFailure("whisper_cpp_output_invalid", "whisper.cpp 返回的语言信息无效。")
    detected = result.get("language")
    language = detected or (requested_language if requested_language not in {None, "", "auto"} else None)
    return {
        "text": " ".join(segment["text"] for segment in segments).strip(),
        "language": language,
        "segments": segments,
    }


def _run_cli(
    command: list[str], executable: Path,
    progress_callback: Callable[[str, float | None], None],
    log_callback: Callable[[str, str], None],
) -> tuple[int, str]:
    tail: deque[str] = deque(maxlen=120)
    try:
        # No detached process/group: task cancellation kills the worker's child tree.
        with subprocess.Popen(
            command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace", bufsize=1,
            env=cli_environment(executable),
        ) as process:
            assert process.stdout is not None
            for line in process.stdout:
                message = line.strip()
                if not message:
                    continue
                tail.append(message)
                matched = PROGRESS_PATTERN.search(message)
                if matched:
                    percent = max(0.0, min(100.0, float(matched.group(1))))
                    progress_callback(f"whisper.cpp 正在转写：{percent:g}%", percent * 0.85)
                else:
                    level = "info" if re.search(r"(device|backend|gpu|vulkan|metal|cuda|cpu)", message, re.I) else "debug"
                    log_callback(level, message)
            return process.wait(), "\n".join(tail)
    except OSError as error:
        raise WhisperCppFailure(
            "whisper_cpp_missing", "whisper.cpp 无法启动，请在模型准备面板重试，系统会检查并准备运行环境。", str(error),
        ) from error


def transcribe(
    audio_path: Path, model_name: str, language: str | None = None, *,
    project_root: Path | str | None = None,
    progress_callback: Callable[[str, float | None], None] = lambda *_: None,
    log_callback: Callable[[str, str], None] = lambda *_: None,
) -> dict[str, Any]:
    executable = cli_path(project_root)
    if not executable.is_file():
        raise WhisperCppFailure(
            "whisper_cpp_missing", "whisper.cpp 尚未安装，请在模型准备面板重试，系统会自动准备运行环境。", str(executable),
        )
    model = model_path(model_name, project_root)
    if not model.is_file() or model.stat().st_size == 0:
        raise WhisperCppFailure(
            "whisper_cpp_model_missing",
            f"whisper.cpp 模型 {model_name} 尚未准备完成。请在模型准备面板下载或重试，完成后即可转写，无需重启。",
            str(model),
        )
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise WhisperCppFailure("ffmpeg_missing", "未找到 FFmpeg，请重新运行启动脚本以自动准备环境。")
    try:
        threads = max(1, min(64, int(os.environ.get("OMP_NUM_THREADS") or min(8, os.cpu_count() or 1))))
    except ValueError:
        threads = min(8, os.cpu_count() or 1)
    cpu_only = os.environ.get("WHISPER_DEVICE", "").strip().lower() == "cpu"
    requested_language = language or "auto"
    progress_callback("正在准备 whisper.cpp 转写音频", 0)
    with tempfile.TemporaryDirectory(prefix="whisper-cpp-") as temporary:
        directory = Path(temporary)
        wav = directory / "input.wav"
        converted = subprocess.run(
            [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", str(audio_path),
             "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(wav)],
            stdin=subprocess.DEVNULL, capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        if converted.returncode != 0 or not wav.is_file():
            raise WhisperCppFailure(
                "ffmpeg_error", "FFmpeg 转换 whisper.cpp 所需的 16 kHz 单声道音频失败。", converted.stderr.strip(),
            )
        output = directory / "transcript"
        result_path = directory / "transcript.json"
        command = [
            str(executable), "-m", str(model), "-f", str(wav), "-l", requested_language,
            "-ojf", "-of", str(output), "-pp", "-t", str(threads),
        ]
        if cpu_only:
            command.append("--no-gpu")
        log_callback("info", (
            f"Loading whisper.cpp model {model_name} from {model}; "
            f"device={'CPU (--no-gpu)' if cpu_only else 'automatic native backend'}, threads={threads}"
        ))
        progress_callback(f"正在加载 whisper.cpp 模型：{model_name}", 0)
        code, details = _run_cli(command, executable, progress_callback, log_callback)
        # Native GPU drivers can terminate before printing an error. Windows
        # reports an unsigned NTSTATUS; POSIX reports a negative signal code.
        crashed = code < 0 or (os.name == "nt" and (code & 0xF0000000) == 0xC0000000)
        backend_failed = code in {3, 10} and re.search(r"ggml_(?:vulkan|metal)|Vulkan\d|Metal device", details, re.I)
        if code != 0 and not cpu_only and (GPU_FAILURE.search(details) or crashed or backend_failed):
            log_callback("warning", f"whisper.cpp GPU 后端启动或执行失败，将使用 CPU 重试一次：\n{details}")
            progress_callback("GPU 后端无法执行，正在改用 CPU 转写", None)
            # Never accept or merge a partial GPU transcript into the CPU result.
            result_path.unlink(missing_ok=True)
            code, details = _run_cli(command + ["--no-gpu"], executable, progress_callback, log_callback)
        if code != 0:
            raise WhisperCppFailure(
                "whisper_cpp_error", f"whisper.cpp 转写失败（退出码 {code}）。", details,
            )
        try:
            payload = json.loads(result_path.read_text(encoding="utf-8-sig"))
            if not isinstance(payload, dict):
                raise ValueError("The CLI result is not a JSON object.")
        except (OSError, UnicodeError, ValueError) as error:
            raise WhisperCppFailure(
                "whisper_cpp_output_invalid", "whisper.cpp 未生成有效的转写 JSON。", str(error),
            ) from error
        return parse_result(payload, language)
