"""Download Whisper weights without constructing or loading an inference model.

The command accepts a JSON request on stdin or --engine/--model/--project-root.
Stdout is JSONL only; cache locations come from the selected runtime environment.
"""
from __future__ import annotations

import argparse
import ast
import contextlib
import ctypes
import hashlib
import importlib.util
import json
import os
import re
import sys
import sysconfig
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Callable


Emit = Callable[[dict], None]
MODEL_ALIASES = {"large": "large-v3", "turbo": "large-v3-turbo"}
CPP_NAMES = frozenset({"tiny", "tiny.en", "base", "base.en", "small", "small.en", "medium", "medium.en", "large-v1", "large-v2", "large-v3", "large-v3-turbo"})
_output_lock = threading.Lock()
_dll_handles = []


class ModelDownloadError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _process_alive(pid: int) -> bool:
    if os.name == "nt":
        # os.kill(pid, 0) can call TerminateProcess on Windows. Querying the
        # handle is read-only and also detects exited-but-not-reaped owners.
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
        kernel.OpenProcess.restype = ctypes.c_void_p
        kernel.GetExitCodeProcess.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32)]
        kernel.GetExitCodeProcess.restype = ctypes.c_int
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            return ctypes.get_last_error() != 87  # ERROR_INVALID_PARAMETER: PID absent.
        try:
            code = ctypes.c_uint32()
            return not kernel.GetExitCodeProcess(handle, ctypes.byref(code)) or code.value == 259
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def emit_json(event: dict) -> None:
    with _output_lock:
        print(json.dumps(event, ensure_ascii=False), flush=True)


def progress(emit: Emit, message: str, downloaded: int | None = None, total: int | None = None) -> None:
    event = {"type": "progress", "message": message}
    if downloaded is not None:
        event["downloadedBytes"] = max(0, downloaded)
    if total is not None and total > 0:
        event["totalBytes"] = total
        if downloaded is not None:
            event["percent"] = min(100, max(0, downloaded / total * 100))
    emit(event)


@contextlib.contextmanager
def cache_lock(lock: Path, emit: Emit, timeout: float = 1200):
    """PID ownership makes a killed download recoverable on Windows and Linux."""
    lock.parent.mkdir(parents=True, exist_ok=True)
    token = uuid.uuid4().hex
    deadline = time.monotonic() + timeout
    notified = False
    while True:
        try:
            with lock.open("x", encoding="utf-8") as output:
                json.dump({"pid": os.getpid(), "token": token}, output)
            break
        except FileExistsError:
            try:
                owner = json.loads(lock.read_text(encoding="utf-8"))
                pid = owner.get("pid")
                if not isinstance(pid, int) or pid <= 0:
                    raise ValueError("Invalid lock owner")
                if not _process_alive(pid):
                    lock.unlink(missing_ok=True)
                    continue
            except (ValueError, OSError):
                try:
                    if time.time() - lock.stat().st_mtime > 30:
                        lock.unlink(missing_ok=True)
                        continue
                except FileNotFoundError:
                    continue
            if time.monotonic() >= deadline:
                raise ModelDownloadError("MODEL_LOCK_TIMEOUT", "另一进程仍在准备此模型，请等待其完成或取消后重试。")
            if not notified:
                progress(emit, "另一进程正在准备相同模型，等待缓存就绪")
                notified = True
            time.sleep(0.25)
    try:
        yield
    finally:
        try:
            if json.loads(lock.read_text(encoding="utf-8")).get("token") == token:
                lock.unlink(missing_ok=True)
        except (OSError, ValueError):
            pass


def _digest(target: Path) -> str:
    digest = hashlib.sha256()
    with target.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _marker(target: Path) -> Path:
    return target.with_name(target.name + ".verified.json")


def _verified(target: Path, sha256: str | None = None) -> bool:
    try:
        stat = target.stat()
        marker = json.loads(_marker(target).read_text(encoding="utf-8"))
        return target.is_file() and stat.st_size > 0 and marker.get("size") == stat.st_size and marker.get("mtimeNs") == stat.st_mtime_ns and bool(re.fullmatch(r"[a-f0-9]{64}", marker.get("sha256", ""))) and (sha256 is None or marker["sha256"] == sha256)
    except (OSError, ValueError, TypeError):
        return False


def _save_marker(target: Path, sha256: str) -> None:
    stat = target.stat()
    marker = _marker(target)
    temporary = marker.with_name(marker.name + f".{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_text(json.dumps({"sha256": sha256, "size": stat.st_size, "mtimeNs": stat.st_mtime_ns}), encoding="utf-8")
        os.replace(temporary, marker)
    finally:
        temporary.unlink(missing_ok=True)


def _open(url: str, headers: dict | None = None):
    return urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Whisper-Studio-model-runtime", **(headers or {})}), timeout=60)


def _transient(error: Exception) -> bool:
    return not isinstance(error, urllib.error.HTTPError) or error.code in {408, 429} or error.code >= 500


def verified_download(url: str, target: Path, sha256: str, emit: Emit, *, opener=_open, retries: int = 3) -> Path:
    """Bounded HTTP retries, resumable partials, streaming SHA256, atomic activation."""
    if not re.fullmatch(r"[a-fA-F0-9]{64}", sha256):
        raise ModelDownloadError("MODEL_CHECKSUM_MISSING", "模型发布者没有提供有效的 SHA256 校验值。")
    sha256 = sha256.lower()
    target.parent.mkdir(parents=True, exist_ok=True)
    if _verified(target, sha256):
        progress(emit, f"复用已校验模型：{target.name}")
        return target
    if target.is_file() and target.stat().st_size:
        progress(emit, f"校验已有模型：{target.name}")
        if _digest(target) == sha256:
            _save_marker(target, sha256)
            return target
    partial = target.with_name(target.name + ".partial")
    partial_metadata = partial.with_name(partial.name + ".json")
    try:
        if json.loads(partial_metadata.read_text(encoding="utf-8")).get("sha256") != sha256:
            partial.unlink(missing_ok=True)
    except (OSError, ValueError):
        partial.unlink(missing_ok=True)
    partial_metadata.write_text(json.dumps({"sha256": sha256}), encoding="utf-8")
    for attempt in range(1, retries + 1):
        resume = partial.stat().st_size if partial.is_file() else 0
        try:
            # A previous response can finish just before cancellation or rename.
            if resume and _digest(partial) == sha256:
                os.replace(partial, target)
                _save_marker(target, sha256)
                partial_metadata.unlink(missing_ok=True)
                return target
            with opener(url, {"Range": f"bytes={resume}-"} if resume else {}) as response:
                status = getattr(response, "status", None) or response.getcode()
                content_range = response.headers.get("Content-Range", "")
                match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", content_range)
                if status == 206 and (not match or int(match[1]) != resume):
                    raise ModelDownloadError("MODEL_RANGE_INVALID", "模型服务器返回了无效的断点续传范围。")
                if status != 206:
                    resume = 0
                length = int(response.headers.get("Content-Length", "0") or 0)
                total = int(match[3]) if status == 206 and match else length or None
                digest = hashlib.sha256()
                if resume:
                    with partial.open("rb") as previous:
                        for chunk in iter(lambda: previous.read(1024 * 1024), b""):
                            digest.update(chunk)
                downloaded = resume
                last_emit = 0.0
                progress(emit, f"下载模型：{target.name}" + (f"（重试 {attempt}/{retries}）" if attempt > 1 else ""), downloaded, total)
                with partial.open("ab" if resume else "wb") as output:
                    while True:
                        chunk = response.read(1024 * 1024)
                        if not chunk:
                            break
                        output.write(chunk)
                        digest.update(chunk)
                        downloaded += len(chunk)
                        if time.monotonic() - last_emit >= 0.2:
                            progress(emit, f"下载模型：{target.name}", downloaded, total)
                            last_emit = time.monotonic()
                    output.flush()
                    os.fsync(output.fileno())
                if total is not None and downloaded != total:
                    raise OSError("模型下载连接提前结束。")
                progress(emit, f"校验模型：{target.name}", downloaded, total)
                if digest.hexdigest() != sha256:
                    partial.unlink(missing_ok=True)
                    partial_metadata.unlink(missing_ok=True)
                    raise ModelDownloadError("MODEL_CHECKSUM_MISMATCH", "模型 SHA256 校验失败，已有可用模型已保留。请重试下载。")
                os.replace(partial, target)
                _save_marker(target, sha256)
                partial_metadata.unlink(missing_ok=True)
                return target
        except ModelDownloadError:
            raise
        except (OSError, urllib.error.URLError) as error:
            if isinstance(error, urllib.error.HTTPError) and error.code == 416 and resume and attempt < retries:
                partial.unlink(missing_ok=True)
                progress(emit, "服务器无法继续当前断点，重新下载完整模型")
                continue
            if attempt == retries or not _transient(error):
                code = error.code if isinstance(error, urllib.error.HTTPError) else "连接失败"
                raise ModelDownloadError("MODEL_DOWNLOAD_FAILED", f"模型下载失败（{code}）；已保留断点，点击重试可继续下载。") from error
            time.sleep(attempt * 0.5)
    raise ModelDownloadError("MODEL_DOWNLOAD_FAILED", "模型下载失败。")


def _model_map(package: str, filename: str) -> dict:
    # Reading the publisher's installed map avoids importing Torch/CTranslate2
    # and allocating an inference model just to discover a download URL.
    specification = importlib.util.find_spec(package)
    if not specification or not specification.origin:
        raise ModelDownloadError("MODEL_DEPENDENCY_MISSING", f"所选 Python 环境没有安装 {package}。")
    source = Path(specification.origin).parent / filename
    for statement in ast.parse(source.read_text(encoding="utf-8")).body:
        if isinstance(statement, ast.Assign) and any(isinstance(name, ast.Name) and name.id == "_MODELS" for name in statement.targets):
            values = ast.literal_eval(statement.value)
            if isinstance(values, dict) and all(isinstance(name, str) and isinstance(value, str) for name, value in values.items()):
                return values
    raise ModelDownloadError("MODEL_METADATA_INVALID", f"无法读取 {package} 的模型清单。")


def _cpp_download(model: str, root: Path, emit: Emit) -> Path:
    name = MODEL_ALIASES.get(model, model)
    if name not in CPP_NAMES:
        raise ModelDownloadError("MODEL_UNSUPPORTED", f"whisper.cpp 不支持模型 {model}。")
    directory = Path(os.environ.get("WHISPER_CPP_MODEL_DIR", "").strip() or root / ".runtime" / "models" / "whisper-cpp").resolve()
    target = directory / f"ggml-{name}.bin"
    with cache_lock(target.with_name(target.name + ".lock"), emit):
        if _verified(target):
            progress(emit, f"复用已校验模型：{target.name}")
            return target
        progress(emit, "读取模型发布者的校验信息")
        endpoint = os.environ.get("HF_ENDPOINT", "https://huggingface.co").rstrip("/")
        if not endpoint.startswith("https://"):
            raise ModelDownloadError("MODEL_ENDPOINT_INVALID", "HF_ENDPOINT 必须使用 HTTPS。")
        metadata_url = f"{endpoint}/api/models/ggerganov/whisper.cpp/tree/main"
        for attempt in range(1, 4):
            try:
                with _open(metadata_url) as response:
                    raw = response.read(2 * 1024 * 1024 + 1)
                if len(raw) > 2 * 1024 * 1024:
                    raise ModelDownloadError("MODEL_METADATA_INVALID", "模型校验信息过大。")
                entry = next((item for item in json.loads(raw) if item.get("path") == target.name), {})
                checksum = entry.get("lfs", {}).get("oid", "")
                return verified_download(f"{endpoint}/ggerganov/whisper.cpp/resolve/main/{target.name}", target, checksum, emit)
            except (OSError, urllib.error.URLError) as error:
                if attempt == 3 or not _transient(error):
                    raise ModelDownloadError("MODEL_METADATA_UNAVAILABLE", "无法读取模型校验信息，请检查网络后重试。") from error
                time.sleep(attempt * 0.5)
        raise ModelDownloadError("MODEL_METADATA_UNAVAILABLE", "无法读取模型校验信息。")


def _openai_download(model: str, emit: Emit) -> Path:
    models = _model_map("whisper", "__init__.py")
    if model not in models:
        raise ModelDownloadError("MODEL_UNSUPPORTED", f"openai-whisper 不支持模型 {model}。")
    url = models[model]
    directory = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "whisper"
    target = directory / url.rsplit("/", 1)[-1]
    with cache_lock(target.with_name(target.name + ".lock"), emit):
        return verified_download(url, target, url.split("/")[-2], emit)


def _faster_download(model: str, emit: Emit) -> Path:
    models = _model_map("faster_whisper", "utils.py")
    if model not in models:
        raise ModelDownloadError("MODEL_UNSUPPORTED", f"faster-whisper 不支持模型 {model}。")
    import huggingface_hub
    from huggingface_hub import constants
    from tqdm.auto import tqdm

    patterns = ["config.json", "preprocessor_config.json", "model.bin", "tokenizer.json", "vocabulary.*"]
    repository = models[model]
    cache_root = Path(constants.HF_HUB_CACHE)
    lock_name = hashlib.sha256(repository.encode()).hexdigest()

    class DownloadProgress(tqdm):
        def __init__(self, *args, **kwargs):
            self._last_event = 0.0
            self._byte_progress = kwargs.get("unit") in {"B", "iB"}
            kwargs.pop("name", None)
            kwargs["disable"] = False
            kwargs["file"] = sys.stderr
            super().__init__(*args, **kwargs)

        def display(self, *args, **kwargs):
            if not self._byte_progress or time.monotonic() - self._last_event < 0.2:
                return
            self._last_event = time.monotonic()
            progress(emit, f"下载模型：{model}（{self.desc or '权重文件'}）", int(self.n), int(self.total) if self.total else None)

    def valid(folder: str) -> bool:
        return all((Path(folder) / name).is_file() and (Path(folder) / name).stat().st_size > 0 for name in ["model.bin", "config.json"])

    with cache_lock(cache_root / ".locks" / f"whisper-studio-{lock_name}.lock", emit):
        try:
            cached = huggingface_hub.snapshot_download(repository, allow_patterns=patterns, local_files_only=True)
            if valid(cached):
                progress(emit, f"复用已有模型：{model}")
                return Path(cached)
        except (OSError, ValueError):
            pass
        progress(emit, f"准备下载 faster-whisper 模型：{model}")
        for attempt in range(1, 4):
            try:
                downloaded = huggingface_hub.snapshot_download(repository, allow_patterns=patterns, tqdm_class=DownloadProgress, max_workers=4)
                if not valid(downloaded):
                    raise ModelDownloadError("MODEL_DOWNLOAD_INCOMPLETE", "模型缓存缺少完整权重或配置，请重试。")
                return Path(downloaded)
            except ModelDownloadError:
                raise
            except Exception as error:
                status = getattr(getattr(error, "response", None), "status_code", None)
                if attempt == 3 or status is not None and status not in {408, 429} and status < 500:
                    raise ModelDownloadError("MODEL_DOWNLOAD_FAILED", f"faster-whisper 模型下载失败（{type(error).__name__}），缓存断点已保留，请检查网络后重试。") from error
                progress(emit, f"模型连接中断，继续下载（重试 {attempt + 1}/3）")
                time.sleep(attempt * 0.5)
    raise ModelDownloadError("MODEL_DOWNLOAD_FAILED", "模型下载失败。")


def download_model(engine: str, model: str, project_root: str | Path, emit: Emit = emit_json) -> Path:
    if not re.fullmatch(r"[a-zA-Z0-9.-]+", model):
        raise ModelDownloadError("MODEL_UNSUPPORTED", "请选择有效的 Whisper 模型名称。")
    if engine == "whisper.cpp":
        return _cpp_download(model, Path(project_root).resolve(), emit)
    if engine == "whisper":
        return _openai_download(model, emit)
    if engine == "faster-whisper":
        return _faster_download(model, emit)
    raise ModelDownloadError("MODEL_ENGINE_UNSUPPORTED", "请选择有效的转写引擎。")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine")
    parser.add_argument("--model")
    parser.add_argument("--project-root")
    arguments = parser.parse_args()
    try:
        request = {"engine": arguments.engine, "model": arguments.model, "projectRoot": arguments.project_root} if arguments.engine else json.load(sys.stdin)
        if not isinstance(request, dict) or not all(isinstance(request.get(name), str) and request[name].strip() for name in ["engine", "model", "projectRoot"]):
            raise ModelDownloadError("MODEL_REQUEST_INVALID", "模型准备请求缺少引擎、模型或项目路径。")
        if sys.platform == "win32":
            for directory in {sys.prefix, sysconfig.get_path("scripts")}:
                if os.path.isdir(directory):
                    _dll_handles.append(os.add_dll_directory(directory))
        result = download_model(request["engine"], request["model"], request["projectRoot"])
        emit_json({"type": "result", "path": str(result)})
        return 0
    except ModelDownloadError as error:
        emit_json({"type": "error", "message": str(error), "code": error.code})
    except Exception as error:
        emit_json({"type": "error", "message": f"模型准备失败（{type(error).__name__}），请重试或检查所选 Python 环境。", "code": "MODEL_PREPARATION_FAILED"})
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
