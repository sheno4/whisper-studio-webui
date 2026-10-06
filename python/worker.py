from __future__ import annotations

import contextlib
import configparser
import importlib
import io
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import sysconfig
import tempfile
import threading
import time
import traceback
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs, urlparse
from urllib.request import urlopen

try:
    from .parallel_download import connection_count, parallel_http_downloads
    from .bilibili_download import bilibili_download_sources
    from . import whisper_cpp_backend
except ImportError:
    from parallel_download import connection_count, parallel_http_downloads
    from bilibili_download import bilibili_download_sources
    import whisper_cpp_backend


AUDIO_EXTENSIONS = {
    ".mp3",
    ".wav",
    ".m4a",
    ".aac",
    ".flac",
    ".ogg",
    ".opus",
    ".wma",
    ".webm",
}
VIDEO_EXTENSIONS = {".mp4", ".mov", ".mkv", ".avi", ".flv", ".wmv", ".m4v", ".ts"}
LOG_FILE: Path | None = None
LOG_LEVEL = "info"
LOG_LEVEL_ORDER = {"debug": 0, "info": 1, "warning": 2, "error": 3}
OPENAI_WHISPER_MODEL_CACHE: dict[str, Any] = {}
FASTER_WHISPER_MODEL_CACHE: dict[tuple[str, str, str], Any] = {}
CUDA_DLL_DIRECTORY_HANDLES: dict[str, Any] = {}
LAST_PROGRESS_STATUS: str | None = None
LAST_PROGRESS_PERCENT: float | None = None
DOUYIN_MOBILE_USER_AGENT = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
)
DOUYIN_MEDIA_HOST_SUFFIX = ".douyinvod.com"
DOUYIN_BROWSER_TIMEOUT_SECONDS = 25
BILIBILI_DESKTOP_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36"
)
YOUTUBE_INVIDIOUS_INSTANCES_API = "https://api.invidious.io/instances.json?sort_by=health"
YOUTUBE_INVIDIOUS_FALLBACK_URIS = (
    "https://inv.thepixora.com",
    "https://yt.chocolatemoo53.com",
    "https://invidious.nerdvpn.de",
    "https://inv.nadeko.net",
)


@dataclass
class WorkerFailure(Exception):
    code: str
    message: str
    details: str | None = None

    def __str__(self) -> str:
        return self.message


@dataclass
class DownloadOutcome:
    output_dir: Path
    display_name: str
    transcript_input_path: Path | None
    temp_audio_path: Path | None
    downloaded_media_path: Path | None
    source_media_path: str | None
    media_info: dict[str, Any]


@dataclass
class BrowserMediaCapture:
    url: str
    user_agent: str
    referer: str
    audio_url: str | None = None
    title: str | None = None


class YTDLPQuietLogger:
    def debug(self, message: str) -> None:
        return

    def warning(self, message: str) -> None:
        log("warning", message, "yt-dlp")

    def error(self, message: str) -> None:
        log("warning", message, "yt-dlp")


def configure_stdio() -> None:
    with contextlib.suppress(AttributeError):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    with contextlib.suppress(AttributeError):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)


def configure_faster_whisper_cuda_runtime() -> None:
    if sys.platform != "win32":
        return

    # msvc-runtime wheels place DLLs in Scripts or sys.prefix. Register these
    # before importing any native extension, including CTranslate2 or PyTorch.
    # Keep handles alive: closing one removes that DLL search directory.
    nvidia_dir = Path(sysconfig.get_path("purelib")) / "nvidia"
    candidates = [Path(sys.executable).parent, Path(sys.prefix) / "Scripts", Path(sys.prefix)]
    candidates.extend(sorted(nvidia_dir.glob("*/bin")))
    directories = list(dict.fromkeys(str(candidate) for candidate in candidates if candidate.is_dir()))
    for directory in directories:
        if directory not in CUDA_DLL_DIRECTORY_HANDLES:
            with contextlib.suppress(OSError):
                CUDA_DLL_DIRECTORY_HANDLES[directory] = os.add_dll_directory(directory)
    if directories:
        existing = os.environ.get("PATH", "").split(os.pathsep)
        installed = {os.path.normcase(directory) for directory in directories}
        os.environ["PATH"] = os.pathsep.join(
            directories + [entry for entry in existing if os.path.normcase(entry) not in installed]
        )


configure_faster_whisper_cuda_runtime()


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def log(level: str, message: str, context: str | None = None) -> None:
    if LOG_LEVEL_ORDER.get(level, 1) < LOG_LEVEL_ORDER.get(LOG_LEVEL, 1):
        return

    if LOG_FILE:
        with LOG_FILE.open("a", encoding="utf-8") as handle:
            handle.write(
                json.dumps(
                    {
                        "timestamp": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat().replace("+00:00", "Z"),
                        "level": level,
                        "message": message,
                        "context": context,
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )

    emit({"type": "log", "level": level, "message": message, "context": context})


def progress(status: str, message: str, percent: float | None = None) -> None:
    global LAST_PROGRESS_STATUS, LAST_PROGRESS_PERCENT

    payload: dict[str, Any] = {"type": "progress", "status": status, "message": message}
    if percent is not None:
        if (
            status == "transcribing"
            and LAST_PROGRESS_STATUS == status
            and LAST_PROGRESS_PERCENT is not None
        ):
            percent = max(percent, LAST_PROGRESS_PERCENT)
        payload["percent"] = percent
        LAST_PROGRESS_PERCENT = percent
    else:
        LAST_PROGRESS_PERCENT = None

    LAST_PROGRESS_STATUS = status
    emit(payload)


def emit_metadata(display_name: str | None = None, output_dir: Path | None = None) -> None:
    payload: dict[str, Any] = {"type": "metadata"}
    if display_name:
        payload["displayName"] = display_name
    if output_dir:
        payload["outputDir"] = str(output_dir)
    emit(payload)


def fail(code: str, message: str, details: str | None = None) -> None:
    raise WorkerFailure(code=code, message=message, details=details)


def sanitize_name(value: str, fallback: str = "task") -> str:
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1F]+', " ", value)
    cleaned = re.sub(r"\s+", " ", cleaned).strip().strip(".")
    return (cleaned[:100] or fallback).strip()


def format_duration(seconds: float | int | None) -> str | None:
    if seconds is None:
        return None

    total_seconds = max(0, int(round(float(seconds))))
    hours, remainder = divmod(total_seconds, 3600)
    minutes, secs = divmod(remainder, 60)

    if hours:
        return f"{hours}小时{minutes}分钟"
    if minutes:
        return f"{minutes}分{secs}秒"
    return f"{secs}秒"


def format_elapsed(seconds: float) -> str:
    total_seconds = max(0, int(seconds))
    hours, remainder = divmod(total_seconds, 3600)
    minutes, secs = divmod(remainder, 60)

    if hours:
        return f"{hours:02d}:{minutes:02d}:{secs:02d}"
    return f"{minutes:02d}:{secs:02d}"


def same_path(left: Path | None, right: Path | None) -> bool:
    if left is None or right is None:
        return False
    return os.path.normcase(str(left)) == os.path.normcase(str(right))


def needs_safe_transcription_path(input_path: Path) -> bool:
    normalized = str(input_path)
    try:
        normalized.encode("ascii")
    except UnicodeEncodeError:
        return True

    return len(normalized) >= 180


def stage_transcription_input(input_path: Path, task_id: str) -> tuple[Path, Path | None]:
    if not needs_safe_transcription_path(input_path):
        return input_path, None

    staging_root = Path(tempfile.gettempdir()) / "whisper-studio-transcribe"
    staging_root.mkdir(parents=True, exist_ok=True)
    stage_dir = Path(
        tempfile.mkdtemp(
            prefix=f"{sanitize_name(task_id, 'task')[:16]}-",
            dir=str(staging_root),
        )
    )
    staged_input_path = stage_dir / f"input{input_path.suffix.lower() or '.bin'}"
    shutil.copy2(input_path, staged_input_path)
    log("info", f"Staged transcription input at {staged_input_path}", "transcription")
    return staged_input_path, stage_dir


def reserve_output_dir(root_output_dir: Path, display_name: str, current_output_dir: Path | None = None) -> Path:
    base_name = sanitize_name(display_name, "task")
    candidate = root_output_dir / base_name
    suffix = 2

    while True:
        if current_output_dir and same_path(candidate, current_output_dir):
            return current_output_dir

        if not candidate.exists():
            return candidate

        candidate = root_output_dir / f"{base_name} ({suffix})"
        suffix += 1


def switch_output_dir(current_output_dir: Path, display_name: str) -> Path:
    global LOG_FILE

    while True:
        target_output_dir = reserve_output_dir(current_output_dir.parent, display_name, current_output_dir)
        if same_path(current_output_dir, target_output_dir):
            break
        try:
            current_output_dir.rename(target_output_dir)
            if LOG_FILE:
                LOG_FILE = target_output_dir / LOG_FILE.name
            break
        except OSError:
            if not target_output_dir.exists():
                raise
    emit_metadata(display_name, target_output_dir)
    return target_output_dir


def is_auth_gate_error_message(text: str) -> bool:
    lowered = text.lower()
    return any(
        marker in lowered
        for marker in (
            "fresh cookies",
            "cookies",
            "login required",
            "members-only",
            "members only",
            "membership",
            "join this channel",
            "sign in",
            "not necessarily logged in",
            "confirm you’re not a bot",
            "confirm you're not a bot",
            "bot",
        )
    )


def classify_error(error: Exception) -> WorkerFailure:
    if isinstance(error, WorkerFailure):
        return error
    if isinstance(error, whisper_cpp_backend.WhisperCppFailure):
        return WorkerFailure(error.code, error.message, error.details)

    text = str(error)
    lowered = text.lower()

    if isinstance(error, FileNotFoundError):
        return WorkerFailure("file_not_found", "未找到要处理的文件。", text)

    if "ssl" in lowered and "eof" in lowered:
        return WorkerFailure("ssl_eof", "网络连接中断（SSL EOF）。请稍后重试，或更换网络后再试。", text)

    if "ffmpeg" in lowered and ("not found" in lowered or "no such file" in lowered):
        return WorkerFailure("ffmpeg_missing", "没有检测到 ffmpeg，无法提取音频或处理下载结果。", text)

    if is_auth_gate_error_message(text):
        return WorkerFailure(
            "auth_required",
            "当前线路被站点拦截，应用已尝试无登录下载通道，但仍未拿到可用媒体地址。",
            text,
        )

    if "video unavailable" in lowered or "not available" in lowered:
        return WorkerFailure("link_unavailable", "这个链接当前不可用，可能已失效、被删除，或仅限特定地区/账号访问。", text)

    if "members only" in lowered or "premium" in lowered or "subscription" in lowered:
        return WorkerFailure("membership_required", "该内容可能需要会员权限或账号授权。", text)

    if "network" in lowered or "timed out" in lowered or "connection" in lowered:
        return WorkerFailure("network_error", "下载时网络异常，请检查网络连接后重试。", text)

    if "whisper" in lowered and ("model" in lowered or "load" in lowered):
        return WorkerFailure("whisper_model_error", "Whisper 模型加载失败，请检查模型名称或本地环境。", text)

    return WorkerFailure("unknown_error", text or "发生了未知错误。", traceback.format_exc())


def ensure_ffmpeg() -> str:
    executable = shutil.which("ffmpeg")
    if not executable:
        fail("ffmpeg_missing", "没有检测到 ffmpeg，请先安装并加入 PATH。")
    return executable


def resolve_ffprobe() -> str | None:
    executable = shutil.which("ffprobe")
    if executable:
        return executable

    ffmpeg_executable = shutil.which("ffmpeg")
    if not ffmpeg_executable:
        return None

    sibling = Path(ffmpeg_executable).with_name("ffprobe.exe" if os.name == "nt" else "ffprobe")
    return str(sibling) if sibling.exists() else None


def probe_media_duration_seconds(input_path: Path) -> float | None:
    ffprobe = resolve_ffprobe()
    if not ffprobe:
        return None

    result = run_command(
        [
            ffprobe,
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(input_path),
        ]
    )
    if result.returncode != 0:
        return None

    try:
        duration = float((result.stdout or "").strip())
    except ValueError:
        return None

    return duration if duration > 0 else None


def read_request() -> dict[str, Any]:
    raw = sys.stdin.read()
    if not raw.strip():
        fail("invalid_request", "没有收到任务参数。")

    try:
        return json.loads(raw)
    except json.JSONDecodeError as error:
        fail("invalid_request", "任务参数不是有效的 JSON。", str(error))


def run_command(command: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )


def detect_js_runtimes() -> dict[str, dict[str, str]]:
    runtimes: dict[str, dict[str, str]] = {}
    executable_map = {
        "deno": "deno",
        "node": "node",
        "quickjs": "qjs",
        "bun": "bun",
    }

    for runtime_name, executable_name in executable_map.items():
        executable_path = shutil.which(executable_name)
        if executable_path:
            runtimes[runtime_name] = {"path": executable_path}

    return runtimes


def env_check() -> None:
    ffmpeg_path = shutil.which("ffmpeg")
    ffmpeg_version = None
    if ffmpeg_path:
        result = run_command(["ffmpeg", "-version"])
        if result.stdout:
            ffmpeg_version = result.stdout.splitlines()[0]

    whisper_ok = False
    whisper_path = None
    try:
        import whisper  # type: ignore

        whisper_ok = True
        whisper_path = whisper.__file__
    except Exception:
        whisper_ok = False

    faster_whisper_ok = False
    faster_whisper_path = None
    try:
        import faster_whisper  # type: ignore

        faster_whisper_ok = True
        faster_whisper_path = faster_whisper.__file__
    except Exception:
        faster_whisper_ok = False

    ytdlp_ok = False
    ytdlp_version = None
    try:
        import yt_dlp  # type: ignore

        ytdlp_ok = True
        ytdlp_version = yt_dlp.version.__version__
    except Exception:
        ytdlp_ok = False

    js_runtimes = detect_js_runtimes()
    cpp_runtime = whisper_cpp_backend.inspect_runtime(
        model_name=os.environ.get("WHISPER_MODEL", "turbo")
        if os.environ.get("WHISPER_ENGINE") == "whisper.cpp" else None,
    )

    print(
        json.dumps(
            {
                "pythonVersion": sys.version.split()[0],
                "whisperOk": whisper_ok,
                "fasterWhisperOk": faster_whisper_ok,
                "ytDlpOk": ytdlp_ok,
                "ffmpegOk": bool(ffmpeg_path),
                "ffmpegVersion": ffmpeg_version,
                "whisperPath": whisper_path,
                "fasterWhisperPath": faster_whisper_path,
                "ytDlpVersion": ytdlp_version,
                "ytDlpJsRuntimes": list(js_runtimes.keys()),
                **cpp_runtime,
            },
            ensure_ascii=False,
        )
    )


def is_douyin_url(url: str) -> bool:
    hostname = (urlparse(url).hostname or "").lower()
    return hostname.endswith("douyin.com") or hostname.endswith("iesdouyin.com") or hostname.endswith("v.douyin.com")


def is_bilibili_url(url: str) -> bool:
    hostname = (urlparse(url).hostname or "").lower()
    return hostname.endswith("bilibili.com") or hostname.endswith("b23.tv")


def is_youtube_url(url: str) -> bool:
    hostname = (urlparse(url).hostname or "").lower()
    return any(hostname == domain or hostname.endswith("." + domain) for domain in ("youtube.com", "youtu.be"))


def youtube_login_candidates(source: str, profile: str, project_root: str) -> list[tuple[str, dict[str, Any]]]:
    """Prefer Firefox's installed default profile; never export browser cookies to disk."""
    if source not in {"auto", "firefox", "chrome", "file", "none"}:
        fail("youtube_login_invalid", "YouTube 登录来源无效，请重新选择。")
    if source == "auto":
        profile = ""
    candidates: list[tuple[str, dict[str, Any]]] = []
    if source in {"auto", "firefox"}:
        profiles: list[str | None] = [profile] if profile else []
        root = Path(os.environ.get("APPDATA", "")) / "Mozilla" / "Firefox"
        if not profiles and (root / "profiles.ini").is_file():
            config = configparser.ConfigParser(interpolation=None)
            config.read(root / "profiles.ini", encoding="utf-8")
            paths = [config[s].get("Default", "") for s in config.sections() if s.startswith("Install")]
            paths += [config[s].get("Path", "") for s in config.sections() if s.startswith("Profile")]
            for value in paths:
                path = root / value
                if value and (path / "cookies.sqlite").is_file() and str(path) not in profiles:
                    profiles.append(str(path))
        for index, value in enumerate(profiles or [None]):
            candidates.append((f"Firefox {index + 1}", {"cookiesfrombrowser": ("firefox", value, None, None)}))
    if source in {"auto", "chrome"}:
        candidates.append(("Chrome", {"cookiesfrombrowser": ("chrome", profile or None, None, None)}))
    cookie_file = Path(project_root) / "cookies.txt"
    if source == "file" or (source == "auto" and cookie_file.is_file()):
        if not cookie_file.is_file():
            fail("youtube_cookies_missing", "项目目录中没有 cookies.txt，请选择已登录的 Firefox 或 Chrome。")
        candidates.append(("cookies.txt", {"cookiefile": str(cookie_file)}))
    if source in {"auto", "none"}:
        candidates.append(("未登录", {}))
    return candidates


def probe_youtube_session(url: str, options: dict[str, Any], source: str, profile: str, project_root: str):
    import yt_dlp
    from yt_dlp.cookies import load_cookies

    errors: list[str] = []
    for label, auth in youtube_login_candidates(source, profile, project_root):
        log("info", f"正在使用 {label} 解析 YouTube 视频", "yt-dlp")
        try:
            with yt_dlp.YoutubeDL({**options, "socket_timeout": 20, "retries": 1}) as downloader:
                jar = load_cookies(auth.get("cookiefile"), auth.get("cookiesfrombrowser"), downloader)
                # Only YouTube/Google cookies participate in this YouTube session.
                for cookie in list(jar):
                    domain = cookie.domain.lstrip(".").lower()
                    if not any(domain == allowed or domain.endswith("." + allowed)
                               for allowed in ("youtube.com", "google.com")):
                        jar.clear(cookie.domain, cookie.path, cookie.name)
                # A supplied cookie file is read-only. Never persist the browser session.
                downloader.cookiejar = jar
                info = downloader.extract_info(url, download=False)
                if not info:
                    raise ValueError("没有获得视频信息")
                log("info", f"YouTube 已使用 {label} 完成解析，下载将复用此登录状态", "yt-dlp")
                return info, jar
        except Exception as error:
            errors.append(f"{label}: {error}")
            log("warning", f"{label} 未能解析视频，正在检查下一登录来源", "yt-dlp")
    fail("youtube_login_failed", "YouTube 视频解析失败。请确认所选浏览器能播放此视频，登录账号具有对应会员等级。Windows 下建议使用 Firefox；Chrome 的 Cookie 可能被占用或加密保护。", "\n".join(errors))


def build_site_http_headers(url: str) -> dict[str, str]:
    if is_bilibili_url(url):
        return {
            "Referer": "https://www.bilibili.com/",
            "Origin": "https://www.bilibili.com",
            "User-Agent": BILIBILI_DESKTOP_USER_AGENT,
        }

    return {}


def extract_douyin_video_id(url: str) -> str | None:
    try:
        parsed = urlparse(url)
    except Exception:
        return None

    path_match = re.search(r"/video/(\d{8,})", parsed.path)
    if path_match:
        return path_match.group(1)

    for key in ("modal_id", "item_id"):
        match = re.search(rf"(?:[?&]){key}=(\d{{8,}})", url)
        if match:
            return match.group(1)

    return None


def resolve_douyin_video_id(url: str) -> str | None:
    video_id = extract_douyin_video_id(url)
    if video_id:
        return video_id

    if not is_douyin_url(url):
        return None

    try:
        import requests  # type: ignore

        response = requests.get(
            url,
            headers={"User-Agent": DOUYIN_MOBILE_USER_AGENT, "Referer": "https://www.douyin.com/"},
            timeout=20,
            allow_redirects=True,
        )
        response.raise_for_status()
        return extract_douyin_video_id(response.url)
    except Exception:
        return None


def extract_douyin_share_item(page_text: str) -> dict[str, Any]:
    match = re.search(r"window\._ROUTER_DATA\s*=\s*(\{.*?\})</script>", page_text, re.S)
    if not match:
        fail("download_failed", "抖音分享页里没有找到视频信息。")

    router_data = json.loads(match.group(1))
    loader_data = router_data.get("loaderData")
    if not isinstance(loader_data, dict):
        fail("download_failed", "抖音分享页返回的数据格式不完整。")

    page_payload = next(
        (
            value
            for value in loader_data.values()
            if isinstance(value, dict)
            and isinstance(value.get("videoInfoRes"), dict)
            and isinstance(value["videoInfoRes"].get("item_list"), list)
        ),
        None,
    )
    if not page_payload:
        fail("download_failed", "抖音分享页没有返回可下载的视频条目。")

    item_list = page_payload["videoInfoRes"].get("item_list") or []
    if not item_list or not isinstance(item_list[0], dict):
        fail("download_failed", "抖音分享页没有返回视频详情。")

    return item_list[0]


def get_requested_height(video_quality: str) -> int | None:
    mapping = {
        "1080p": 1080,
        "720p": 720,
        "480p": 480,
    }
    return mapping.get(video_quality)


def build_video_format(video_quality: str) -> str:
    requested_height = get_requested_height(video_quality)
    if requested_height is None:
        return "bv*+ba/b"

    return f"bestvideo[height<={requested_height}]+bestaudio/best[height<={requested_height}]"


def extract_youtube_video_id(url: str) -> str | None:
    try:
        parsed = urlparse(url)
        hostname = (parsed.hostname or "").lower()

        if hostname.endswith("youtu.be"):
            candidate = parsed.path.strip("/").split("/", 1)[0]
            return candidate or None

        if hostname.endswith("youtube.com"):
            if parsed.path == "/watch":
                candidate = parse_qs(parsed.query).get("v", [None])[0]
                return candidate or None

            parts = [part for part in parsed.path.split("/") if part]
            if len(parts) >= 2 and parts[0] in {"embed", "shorts", "live", "v"}:
                return parts[1]
    except Exception:
        return None


def is_douyin_media_url(url: str) -> bool:
    try:
        parsed = urlparse(url)
    except Exception:
        return False

    hostname = (parsed.hostname or "").lower()
    return parsed.scheme == "https" and (
        hostname == DOUYIN_MEDIA_HOST_SUFFIX.lstrip(".")
        or hostname.endswith(DOUYIN_MEDIA_HOST_SUFFIX)
    )


def find_chromium_browser() -> Path | None:
    configured_path = os.environ.get("WHISPER_CHROMIUM_PATH", "").strip()
    candidates: list[str] = [configured_path] if configured_path else []

    for command in (
        "google-chrome",
        "google-chrome-stable",
        "chromium",
        "chromium-browser",
        "microsoft-edge",
        "msedge",
    ):
        resolved = shutil.which(command)
        if resolved:
            candidates.append(resolved)

    if sys.platform == "win32":
        program_files = os.environ.get("PROGRAMFILES", "")
        program_files_x86 = os.environ.get("PROGRAMFILES(X86)", "")
        local_app_data = os.environ.get("LOCALAPPDATA", "")
        candidates.extend(
            str(Path(root) / relative_path)
            for root, relative_path in (
                (program_files, "Google/Chrome/Application/chrome.exe"),
                (program_files_x86, "Google/Chrome/Application/chrome.exe"),
                (local_app_data, "Google/Chrome/Application/chrome.exe"),
                (program_files, "Microsoft/Edge/Application/msedge.exe"),
                (program_files_x86, "Microsoft/Edge/Application/msedge.exe"),
                (local_app_data, "Microsoft/Edge/Application/msedge.exe"),
            )
            if root
        )
    elif sys.platform == "darwin":
        candidates.extend(
            (
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
                "/Applications/Chromium.app/Contents/MacOS/Chromium",
            )
        )

    seen: set[str] = set()
    for candidate in candidates:
        normalized = os.path.normcase(os.path.abspath(candidate))
        if normalized in seen:
            continue
        seen.add(normalized)
        path = Path(candidate)
        if path.is_file():
            return path

    return None


def normalize_douyin_browser_title(value: str | None) -> str | None:
    title = str(value or "").strip()
    if not title or "\ufffd" in title:
        return None

    title = re.sub(r"\s*[-–—]\s*抖音\s*$", "", title).strip()
    return title or None


def capture_douyin_media_via_browser(url: str, browser_path: Path) -> BrowserMediaCapture:
    import websocket  # type: ignore

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as port_socket:
        port_socket.bind(("127.0.0.1", 0))
        debug_port = int(port_socket.getsockname()[1])

    process: subprocess.Popen[bytes] | None = None
    connection: Any = None
    creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0

    with tempfile.TemporaryDirectory(
        prefix="whisper-studio-douyin-",
        ignore_cleanup_errors=True,
    ) as profile_dir:
        try:
            process = subprocess.Popen(
                [
                    str(browser_path),
                    "--headless=new",
                    "--disable-gpu",
                    "--disable-extensions",
                    "--disable-background-networking",
                    "--no-first-run",
                    "--no-default-browser-check",
                    "--autoplay-policy=no-user-gesture-required",
                    f"--user-data-dir={profile_dir}",
                    f"--remote-debugging-port={debug_port}",
                    "--remote-allow-origins=*",
                    "about:blank",
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=creation_flags,
            )

            page_target: dict[str, Any] | None = None
            discovery_deadline = time.monotonic() + 10
            while time.monotonic() < discovery_deadline:
                if process.poll() is not None:
                    raise RuntimeError("临时浏览器提前退出。")
                try:
                    with urlopen(f"http://127.0.0.1:{debug_port}/json", timeout=0.5) as response:
                        targets = json.loads(response.read().decode("utf-8"))
                    page_target = next(
                        (
                            target
                            for target in targets
                            if target.get("type") == "page" and target.get("url") == "about:blank"
                        ),
                        None,
                    )
                    if page_target:
                        break
                except Exception:
                    time.sleep(0.1)

            if not page_target:
                raise RuntimeError("无法连接临时浏览器。")

            websocket_url = str(page_target.get("webSocketDebuggerUrl") or "")
            if not websocket_url:
                raise RuntimeError("临时浏览器没有提供调试连接。")

            connection = websocket.create_connection(
                websocket_url,
                timeout=1,
                origin=f"http://127.0.0.1:{debug_port}",
                http_proxy_host=None,
            )
            command_id = 0

            def send_command(method: str, params: dict[str, Any] | None = None) -> int:
                nonlocal command_id
                command_id += 1
                connection.send(
                    json.dumps(
                        {
                            "id": command_id,
                            "method": method,
                            "params": params or {},
                        }
                    )
                )
                return command_id

            send_command("Network.enable")
            send_command("Page.enable")
            send_command("Runtime.enable")
            send_command("Page.navigate", {"url": url})

            capture_deadline = time.monotonic() + DOUYIN_BROWSER_TIMEOUT_SECONDS
            media_url: str | None = None
            audio_url: str | None = None
            request_headers: dict[str, Any] = {}
            first_media_at: float | None = None
            while time.monotonic() < capture_deadline:
                if first_media_at is not None and time.monotonic() - first_media_at >= 3:
                    break
                try:
                    message = json.loads(connection.recv())
                except websocket.WebSocketTimeoutException:
                    continue

                if message.get("method") != "Network.requestWillBeSent":
                    continue

                request = message.get("params", {}).get("request", {})
                candidate_url = str(request.get("url") or "")
                if not is_douyin_media_url(candidate_url):
                    continue

                if first_media_at is None:
                    first_media_at = time.monotonic()
                    request_headers = request.get("headers") or {}

                path = urlparse(candidate_url).path.lower()
                if "media-audio" in path:
                    audio_url = candidate_url
                elif media_url is None:
                    media_url = candidate_url

                if media_url and audio_url:
                    break

            if not media_url:
                raise RuntimeError("临时浏览器没有捕获到抖音媒体流。")

            title_request_id = send_command(
                "Runtime.evaluate",
                {"expression": "document.title", "returnByValue": True},
            )
            title: str | None = None
            title_deadline = time.monotonic() + 2
            while time.monotonic() < title_deadline:
                try:
                    message = json.loads(connection.recv())
                except websocket.WebSocketTimeoutException:
                    continue
                if message.get("id") != title_request_id:
                    continue
                title = normalize_douyin_browser_title(
                    message.get("result", {}).get("result", {}).get("value")
                )
                break

            normalized_headers = {
                str(key).lower(): str(value)
                for key, value in request_headers.items()
                if isinstance(key, str)
            }
            return BrowserMediaCapture(
                url=media_url,
                user_agent=normalized_headers.get("user-agent") or DOUYIN_MOBILE_USER_AGENT,
                referer=normalized_headers.get("referer") or "https://www.douyin.com/",
                audio_url=audio_url,
                title=title,
            )
        finally:
            if connection is not None:
                with contextlib.suppress(Exception):
                    connection.close()
            if process is not None and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)

    match = re.search(r"(?:v=|/)([A-Za-z0-9_-]{11})(?:[?&/]|$)", url)
    return match.group(1) if match else None


def parse_numeric_value(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        stripped = value.strip()
        if stripped.isdigit():
            return int(stripped)
        match = re.search(r"(\d+)", stripped)
        if match:
            return int(match.group(1))
    return None


def normalize_invidious_media_url(instance_uri: str, candidate: str) -> str:
    if not candidate:
        return candidate

    instance = urlparse(instance_uri)
    if candidate.startswith("//"):
        return f"{instance.scheme}:{candidate}"

    http_base = f"http://{instance.netloc}"
    https_base = f"{instance.scheme}://{instance.netloc}"
    if candidate.startswith(http_base):
        return https_base + candidate[len(http_base):]
    if candidate.startswith("/"):
        return instance_uri.rstrip("/") + candidate
    return candidate


def get_invidious_instance_uris() -> list[str]:
    import requests  # type: ignore

    ranked: list[tuple[str, float, float]] = []
    try:
        response = requests.get(
            YOUTUBE_INVIDIOUS_INSTANCES_API,
            headers={"User-Agent": BILIBILI_DESKTOP_USER_AGENT},
            timeout=20,
        )
        response.raise_for_status()
        payload = response.json()

        if isinstance(payload, list):
            for item in payload:
                if not isinstance(item, list) or len(item) < 2 or not isinstance(item[1], dict):
                    continue

                metadata = item[1]
                if metadata.get("type") != "https" or metadata.get("api") is not True:
                    continue

                uri = str(metadata.get("uri") or "").strip().rstrip("/")
                if not uri.startswith("https://"):
                    continue

                monitor = metadata.get("monitor") if isinstance(metadata.get("monitor"), dict) else {}
                if monitor and monitor.get("down"):
                    continue

                stats = metadata.get("stats") if isinstance(metadata.get("stats"), dict) else {}
                playback = stats.get("playback") if isinstance(stats.get("playback"), dict) else {}
                ratio = float(playback.get("ratio") or 0.0)
                uptime = float(monitor.get("uptime") or 0.0) if isinstance(monitor, dict) else 0.0
                ranked.append((uri, ratio, uptime))
    except Exception as error:
        log("warning", f"Failed to refresh Invidious instance list: {error}", "youtube-invidious")

    ranked_uris = [uri for uri, _ratio, _uptime in sorted(ranked, key=lambda item: (-item[1], -item[2], item[0]))]
    ordered_uris = list(dict.fromkeys(ranked_uris + list(YOUTUBE_INVIDIOUS_FALLBACK_URIS)))
    return ordered_uris


def fetch_invidious_video_metadata(instance_uri: str, video_id: str) -> dict[str, Any]:
    import requests  # type: ignore

    response = requests.get(
        f"{instance_uri}/api/v1/videos/{video_id}?local=true&hl=en",
        headers={"User-Agent": BILIBILI_DESKTOP_USER_AGENT},
        timeout=30,
    )
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict):
        fail("download_failed", "YouTube metadata endpoint returned an unexpected response.")
    return payload


def parse_stream_height(stream: dict[str, Any]) -> int | None:
    for key in ("qualityLabel", "quality"):
        value = stream.get(key)
        if isinstance(value, str):
            match = re.search(r"(\d{3,4})p", value)
            if match:
                return int(match.group(1))

    resolution = stream.get("resolution")
    if isinstance(resolution, str):
        match = re.search(r"x(\d{3,4})$", resolution)
        if match:
            return int(match.group(1))

    return None


def parse_stream_bitrate(stream: dict[str, Any]) -> int:
    return parse_numeric_value(stream.get("bitrate")) or 0


def parse_stream_size_bytes(stream: dict[str, Any]) -> int | None:
    return parse_numeric_value(stream.get("clen"))


def is_mp4_stream(stream: dict[str, Any], media_prefix: str) -> bool:
    stream_type = str(stream.get("type") or "")
    container = str(stream.get("container") or "")
    return f"{media_prefix}mp4" in stream_type or container.lower() in {"mp4", "m4a"}


def resolve_stream_extension(stream: dict[str, Any], media_kind: str) -> str:
    container = str(stream.get("container") or "").strip().lower()
    if media_kind == "audio":
        if container == "mp4" or "audio/mp4" in str(stream.get("type") or ""):
            return "m4a"
        if container:
            return container
        if "audio/webm" in str(stream.get("type") or ""):
            return "webm"
        return "m4a"

    if container:
        return container
    if "video/webm" in str(stream.get("type") or ""):
        return "webm"
    return "mp4"


def pick_invidious_audio_stream(metadata: dict[str, Any]) -> dict[str, Any]:
    streams = [
        stream
        for stream in (metadata.get("adaptiveFormats") or [])
        if isinstance(stream, dict) and str(stream.get("type") or "").startswith("audio/")
    ]
    if not streams:
        fail("download_failed", "No downloadable audio stream was returned by the YouTube fallback route.")

    return max(
        streams,
        key=lambda stream: (
            1 if is_mp4_stream(stream, "audio/") else 0,
            parse_stream_bitrate(stream),
            parse_stream_size_bytes(stream) or 0,
        ),
    )


def pick_invidious_video_stream(metadata: dict[str, Any], video_quality: str) -> tuple[dict[str, Any], bool, int | None]:
    candidates: list[tuple[dict[str, Any], bool, int | None]] = []

    for stream in metadata.get("adaptiveFormats") or []:
        if isinstance(stream, dict) and str(stream.get("type") or "").startswith("video/"):
            candidates.append((stream, False, parse_stream_height(stream)))

    for stream in metadata.get("formatStreams") or []:
        if isinstance(stream, dict) and str(stream.get("type") or "").startswith("video/"):
            candidates.append((stream, True, parse_stream_height(stream)))

    if not candidates:
        fail("download_failed", "No downloadable video stream was returned by the YouTube fallback route.")

    requested_height = get_requested_height(video_quality)

    def quality_score(candidate: tuple[dict[str, Any], bool, int | None]) -> tuple[int, int, int, int]:
        stream, has_audio, height = candidate
        return (
            height or 0,
            1 if is_mp4_stream(stream, "video/") else 0,
            parse_stream_bitrate(stream),
            1 if has_audio else 0,
        )

    if requested_height is None:
        selected = max(candidates, key=quality_score)
        return selected

    lower_or_equal = [candidate for candidate in candidates if (candidate[2] or 0) <= requested_height]
    if lower_or_equal:
        return max(lower_or_equal, key=quality_score)

    higher = [candidate for candidate in candidates if candidate[2] is not None]
    if higher:
        higher.sort(
            key=lambda candidate: (
                candidate[2] or 10_000,
                -(1 if is_mp4_stream(candidate[0], "video/") else 0),
                -parse_stream_bitrate(candidate[0]),
                0 if candidate[1] else 1,
            )
        )
        return higher[0]

    return max(candidates, key=quality_score)


def download_invidious_stream(
    *,
    instance_uri: str,
    media_url: str,
    target_path: Path,
    referer_url: str,
    progress_message: str,
    downloaded_bytes_before: int,
    total_bytes: int | None,
    progress_start: int = 4,
    progress_span: int = 60,
) -> int:
    import requests  # type: ignore

    target_path.parent.mkdir(parents=True, exist_ok=True)
    request_url = normalize_invidious_media_url(instance_uri, media_url)
    temp_path = Path(f"{target_path}.part")
    temp_path.unlink(missing_ok=True)

    response = requests.get(
        request_url,
        headers={
            "User-Agent": BILIBILI_DESKTOP_USER_AGENT,
            "Referer": referer_url,
        },
        timeout=60,
        stream=True,
        allow_redirects=True,
    )
    response.raise_for_status()

    expected_total = total_bytes if total_bytes and total_bytes > 0 else None
    downloaded_bytes = 0
    last_percent = float(progress_start)
    last_emit_at = 0.0

    try:
        with temp_path.open("wb") as handle:
            for chunk in response.iter_content(chunk_size=256 * 1024):
                if not chunk:
                    continue

                handle.write(chunk)
                downloaded_bytes += len(chunk)

                if expected_total:
                    percent = progress_start + (
                        (downloaded_bytes_before + downloaded_bytes) * progress_span / expected_total
                    )
                    clamped = round(min(progress_start + progress_span, percent), 1)
                    now = time.monotonic()
                    if clamped > last_percent and (
                        now - last_emit_at >= 0.1 or clamped >= progress_start + progress_span
                    ):
                        progress("downloading", progress_message, clamped)
                        last_percent = clamped
                        last_emit_at = now
                elif time.monotonic() - last_emit_at >= 0.25:
                    progress("downloading", f"{progress_message} ({downloaded_bytes // 1024} KB)")
                    last_emit_at = time.monotonic()

        temp_path.replace(target_path)
        return downloaded_bytes
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise


def merge_media_streams(video_path: Path, audio_path: Path, output_path: Path) -> None:
    ffmpeg = ensure_ffmpeg()
    result = run_command(
        [
            ffmpeg,
            "-y",
            "-i",
            str(video_path),
            "-i",
            str(audio_path),
            "-c",
            "copy",
            str(output_path),
        ]
    )
    if result.returncode != 0:
        fail("ffmpeg_error", "ffmpeg failed while merging downloaded media streams.", result.stderr.strip())


def download_youtube_via_invidious(url: str, output_dir: Path, download_behavior: str, video_quality: str) -> DownloadOutcome:
    video_id = extract_youtube_video_id(url)
    if not video_id:
        fail("download_failed", "Could not resolve a YouTube video id for the fallback route.")

    last_error: Exception | None = None
    for instance_uri in get_invidious_instance_uris():
        try:
            log("info", f"Trying YouTube no-login fallback via {instance_uri}", "youtube-invidious")
            progress("downloading", "正在切换到无登录下载通道", 2)

            metadata = fetch_invidious_video_metadata(instance_uri, video_id)
            title = str(metadata.get("title") or "").strip() or f"youtube-{video_id}"
            output_dir = switch_output_dir(output_dir, title)
            current_output_dir = output_dir
            safe_base_name = sanitize_name(title, f"youtube-{video_id}")
            referer_url = f"{instance_uri}/watch?v={video_id}&local=true"
            duration_seconds = parse_numeric_value(metadata.get("lengthSeconds"))

            info: dict[str, Any] = {
                "id": video_id,
                "title": title,
                "duration": duration_seconds,
                "extractor": "youtube-invidious",
                "webpage_url": url,
                "height": None,
            }

            if download_behavior == "transcribe" or video_quality == "audio":
                audio_stream = pick_invidious_audio_stream(metadata)
                audio_ext = resolve_stream_extension(audio_stream, "audio")
                native_audio_path = current_output_dir / f"{safe_base_name} [{video_id}].{audio_ext}"
                total_bytes = parse_stream_size_bytes(audio_stream)
                progress("downloading", "正在通过无登录通道下载 YouTube 音频", 4)
                download_invidious_stream(
                    instance_uri=instance_uri,
                    media_url=str(audio_stream.get("url") or ""),
                    target_path=native_audio_path,
                    referer_url=referer_url,
                    progress_message="正在通过无登录通道下载 YouTube 音频",
                    downloaded_bytes_before=0,
                    total_bytes=total_bytes,
                )

                if download_behavior == "transcribe":
                    return prepare_download_outcome_from_media(
                        output_dir=current_output_dir,
                        display_name=title,
                        info=info,
                        downloaded_file=native_audio_path,
                        download_behavior=download_behavior,
                        video_quality=video_quality,
                    )

                progress("preprocessing", "音频下载完成，正在整理输出文件", 72)
                final_audio_path = extract_audio_from_video(
                    native_audio_path,
                    current_output_dir,
                    title,
                    percent=72,
                    message="音频下载完成，正在整理输出文件",
                )
                native_audio_path.unlink(missing_ok=True)
                return prepare_download_outcome_from_media(
                    output_dir=current_output_dir,
                    display_name=title,
                    info=info,
                    downloaded_file=final_audio_path,
                    download_behavior=download_behavior,
                    video_quality=video_quality,
                )

            video_stream, stream_has_audio, actual_height = pick_invidious_video_stream(metadata, video_quality)
            info["height"] = actual_height
            total_bytes = parse_stream_size_bytes(video_stream) or 0

            video_ext = resolve_stream_extension(video_stream, "video")
            staged_video_path = current_output_dir / f"{safe_base_name} [{video_id}].video.{video_ext}"
            merged_ext = "mp4" if is_mp4_stream(video_stream, "video/") else "mkv"
            final_media_path = current_output_dir / f"{safe_base_name} [{video_id}].{merged_ext}"

            if stream_has_audio:
                progress("downloading", "正在通过无登录通道下载 YouTube 视频", 4)
                download_invidious_stream(
                    instance_uri=instance_uri,
                    media_url=str(video_stream.get("url") or ""),
                    target_path=final_media_path,
                    referer_url=referer_url,
                    progress_message="正在通过无登录通道下载 YouTube 视频",
                    downloaded_bytes_before=0,
                    total_bytes=total_bytes or None,
                )
                return prepare_download_outcome_from_media(
                    output_dir=current_output_dir,
                    display_name=title,
                    info=info,
                    downloaded_file=final_media_path,
                    download_behavior=download_behavior,
                    video_quality=video_quality,
                    fallback_message=build_quality_fallback_message(video_quality, actual_height, "youtube-invidious"),
                )

            audio_stream = pick_invidious_audio_stream(metadata)
            audio_ext = resolve_stream_extension(audio_stream, "audio")
            staged_audio_path = current_output_dir / f"{safe_base_name} [{video_id}].audio.{audio_ext}"
            total_size = (parse_stream_size_bytes(video_stream) or 0) + (parse_stream_size_bytes(audio_stream) or 0)
            if total_size <= 0:
                total_size = None

            progress("downloading", "正在通过无登录通道下载 YouTube 视频流", 4)
            downloaded_video_bytes = download_invidious_stream(
                instance_uri=instance_uri,
                media_url=str(video_stream.get("url") or ""),
                target_path=staged_video_path,
                referer_url=referer_url,
                progress_message="正在通过无登录通道下载 YouTube 视频流",
                downloaded_bytes_before=0,
                total_bytes=total_size,
            )

            progress("downloading", "正在通过无登录通道下载 YouTube 音频流", 36 if total_size is None else None)
            download_invidious_stream(
                instance_uri=instance_uri,
                media_url=str(audio_stream.get("url") or ""),
                target_path=staged_audio_path,
                referer_url=referer_url,
                progress_message="正在通过无登录通道下载 YouTube 音频流",
                downloaded_bytes_before=downloaded_video_bytes,
                total_bytes=total_size,
            )

            progress("preprocessing", "音视频下载完成，正在合并媒体文件", 72)
            merge_media_streams(staged_video_path, staged_audio_path, final_media_path)
            staged_video_path.unlink(missing_ok=True)
            staged_audio_path.unlink(missing_ok=True)

            return prepare_download_outcome_from_media(
                output_dir=current_output_dir,
                display_name=title,
                info=info,
                downloaded_file=final_media_path,
                download_behavior=download_behavior,
                video_quality=video_quality,
                fallback_message=build_quality_fallback_message(video_quality, actual_height, "youtube-invidious"),
            )
        except Exception as error:
            last_error = error
            log("warning", f"YouTube no-login fallback failed via {instance_uri}: {error}", "youtube-invidious")

    fail(
        "auth_required",
        "当前 YouTube 被站点拦截，应用已尝试无登录下载通道，但当前公共通道暂时不可用，请稍后重试。",
        str(last_error) if last_error else None,
    )


def summarize_remote_media(url: str, info: dict[str, Any] | None, download_behavior: str, video_quality: str) -> str:
    base_action = "正在下载媒体内容"
    if download_behavior == "transcribe":
        base_action = "正在准备转写音频"
    elif video_quality == "audio":
        base_action = "正在下载音频文件"
    else:
        base_action = "正在下载视频文件"

    if not info:
        return base_action

    duration_text = format_duration(info.get("duration"))
    extractor = str(info.get("extractor_key") or info.get("extractor") or "").lower()
    webpage_url = str(info.get("webpage_url") or url)
    hostname = (urlparse(webpage_url).hostname or "").lower()

    if "twitter:spaces" in extractor or "/i/spaces/" in webpage_url:
        return "已识别为 X Spaces 回放，正在保存音频。这类链接通常不会显示下载百分比。"
    if "youtube" in extractor or hostname.endswith("youtube.com") or hostname.endswith("youtu.be"):
        label = "已识别为 YouTube 内容"
    elif "bilibili" in extractor or hostname.endswith("bilibili.com") or hostname.endswith("b23.tv"):
        label = "已识别为 B 站内容"
    elif hostname.endswith("x.com") or hostname.endswith("twitter.com"):
        label = "已识别为 X / Twitter 内容"
    elif hostname.endswith("douyin.com") or hostname.endswith("iesdouyin.com"):
        label = "已识别为抖音内容"
    else:
        label = "已识别到可下载媒体"

    if duration_text:
        return f"{label}，时长约 {duration_text}，{base_action}"
    return f"{label}，{base_action}"


def classify_download_kind(file_path: Path) -> str:
    return "video" if file_path.suffix.lower() in VIDEO_EXTENSIONS else "audio"


def newest_matching_files(directory: Path, extensions: set[str]) -> list[Path]:
    return sorted(
        [item for item in directory.iterdir() if item.is_file() and item.suffix.lower() in extensions],
        key=lambda item: item.stat().st_mtime,
        reverse=True,
    )


def extract_audio_from_video(
    input_path: Path,
    output_dir: Path,
    display_name: str,
    *,
    percent: int = 68,
    message: str = "下载完成，正在提取音频",
) -> Path:
    ffmpeg = ensure_ffmpeg()
    extracted = output_dir / f"{sanitize_name(display_name, 'audio')}.mp3"
    progress("preprocessing", message, percent)
    result = run_command([ffmpeg, "-y", "-i", str(input_path), "-vn", "-acodec", "mp3", str(extracted)])
    if result.returncode != 0:
        fail("ffmpeg_error", "ffmpeg 提取音频失败。", result.stderr.strip())
    return extracted


def build_quality_fallback_message(video_quality: str, actual_height: int | None, extractor: str | None = None) -> str | None:
    requested_height = get_requested_height(video_quality)
    if requested_height is None:
        return None

    if extractor == "douyin-mobile-share":
        return "当前抖音直连只返回站点提供的可用清晰度，已自动下载可获取版本。"

    if actual_height is None:
        return "目标清晰度不可用，已自动降级到站点可提供的版本。"

    if actual_height < requested_height:
        return f"目标清晰度不可用，已自动降级到 {actual_height}p。"

    return None


def build_media_info(
    *,
    info: dict[str, Any],
    download_behavior: str,
    video_quality: str,
    downloaded_file: Path | None,
    fallback_message: str | None = None,
) -> dict[str, Any]:
    downloaded_kind = classify_download_kind(downloaded_file) if downloaded_file else None
    return {
        "extractor": info.get("extractor") or info.get("extractor_key"),
        "webpageUrl": info.get("webpage_url"),
        "durationSeconds": info.get("duration"),
        "requestedQuality": video_quality,
        "downloadBehavior": download_behavior,
        "downloadedKind": downloaded_kind,
        "downloadedExt": downloaded_file.suffix.lower().lstrip(".") if downloaded_file else None,
        "qualityFallbackMessage": fallback_message,
    }


def prepare_download_outcome_from_media(
    *,
    output_dir: Path,
    display_name: str,
    info: dict[str, Any],
    downloaded_file: Path,
    download_behavior: str,
    video_quality: str,
    fallback_message: str | None = None,
) -> DownloadOutcome:
    media_info = build_media_info(
        info=info,
        download_behavior=download_behavior,
        video_quality=video_quality,
        downloaded_file=downloaded_file,
        fallback_message=fallback_message,
    )
    downloaded_kind = media_info["downloadedKind"]

    if download_behavior == "downloadOnly":
        return DownloadOutcome(
            output_dir=output_dir,
            display_name=display_name,
            transcript_input_path=None,
            temp_audio_path=None,
            downloaded_media_path=downloaded_file,
            source_media_path=str(downloaded_file),
            media_info=media_info,
        )

    if download_behavior == "downloadThenTranscribe":
        if downloaded_kind == "audio":
            return DownloadOutcome(
                output_dir=output_dir,
                display_name=display_name,
                transcript_input_path=downloaded_file,
                temp_audio_path=None,
                downloaded_media_path=downloaded_file,
                source_media_path=str(downloaded_file),
                media_info=media_info,
            )

        extracted_audio = extract_audio_from_video(
            downloaded_file,
            output_dir,
            display_name,
            percent=72,
            message="视频已下载，正在提取转写音频",
        )
        return DownloadOutcome(
            output_dir=output_dir,
            display_name=display_name,
            transcript_input_path=extracted_audio,
            temp_audio_path=extracted_audio,
            downloaded_media_path=downloaded_file,
            source_media_path=str(downloaded_file),
            media_info=media_info,
        )

    if downloaded_kind == "audio":
        return DownloadOutcome(
            output_dir=output_dir,
            display_name=display_name,
            transcript_input_path=downloaded_file,
            temp_audio_path=downloaded_file,
            downloaded_media_path=None,
            source_media_path=str(downloaded_file),
            media_info=media_info,
        )

    extracted_audio = extract_audio_from_video(
        downloaded_file,
        output_dir,
        display_name,
        percent=72,
        message="视频已下载，正在提取转写音频",
    )
    downloaded_file.unlink(missing_ok=True)
    return DownloadOutcome(
        output_dir=output_dir,
        display_name=display_name,
        transcript_input_path=extracted_audio,
        temp_audio_path=extracted_audio,
        downloaded_media_path=None,
        source_media_path=str(extracted_audio),
        media_info=media_info,
    )


def download_douyin_via_share_page(
    url: str, output_dir: Path, download_behavior: str, video_quality: str
) -> DownloadOutcome:
    import requests  # type: ignore

    video_id = resolve_douyin_video_id(url)
    if not video_id:
        fail("download_failed", "无法从抖音链接中识别视频编号。")

    share_url = f"https://www.iesdouyin.com/share/video/{video_id}/"
    progress("downloading", "正在解析抖音分享页", 1)
    log("info", f"Trying Douyin mobile share page: {share_url}", "douyin-share")

    page_response = requests.get(
        share_url,
        headers={"User-Agent": DOUYIN_MOBILE_USER_AGENT, "Referer": "https://www.douyin.com/"},
        timeout=20,
    )
    page_response.raise_for_status()
    item = extract_douyin_share_item(page_response.text)

    video_info = item.get("video") if isinstance(item.get("video"), dict) else None
    play_addr = video_info.get("play_addr") if isinstance(video_info, dict) else None
    play_url_list = play_addr.get("url_list") if isinstance(play_addr, dict) else None
    if not isinstance(play_url_list, list) or not play_url_list or not isinstance(play_url_list[0], str):
        fail("download_failed", "抖音分享页没有返回可下载的视频地址。")

    raw_title = str(item.get("desc") or "").strip() or f"douyin-{video_id}"
    raw_duration = video_info.get("duration") if isinstance(video_info, dict) else None
    duration = float(raw_duration / 1000) if isinstance(raw_duration, (int, float)) else None
    return download_douyin_media_url(
        play_url=play_url_list[0],
        video_id=video_id,
        raw_title=raw_title,
        output_dir=output_dir,
        download_behavior=download_behavior,
        video_quality=video_quality,
        extractor="douyin-mobile-share",
        webpage_url=share_url,
        duration=duration,
        request_headers={
            "User-Agent": DOUYIN_MOBILE_USER_AGENT,
            "Referer": "https://www.iesdouyin.com/",
        },
    )


def download_douyin_media_url(
    *,
    play_url: str,
    video_id: str,
    raw_title: str,
    output_dir: Path,
    download_behavior: str,
    video_quality: str,
    extractor: str,
    webpage_url: str,
    duration: float | None,
    request_headers: dict[str, str],
    audio_url: str | None = None,
) -> DownloadOutcome:
    import requests  # type: ignore

    if not is_douyin_media_url(play_url):
        fail("download_failed", "抖音解析结果不是受支持的媒体地址。")
    if audio_url and not is_douyin_media_url(audio_url):
        fail("download_failed", "抖音音频解析结果不是受支持的媒体地址。")

    safe_base_name = sanitize_name(raw_title, f"douyin-{video_id}")

    def download_stream(
        stream_url: str,
        target_path: Path,
        message: str,
        progress_start: float,
        progress_span: float,
    ) -> None:
        part_path = Path(f"{target_path}.part")
        part_path.unlink(missing_ok=True)
        try:
            with requests.get(
                stream_url,
                headers=request_headers,
                timeout=60,
                stream=True,
                allow_redirects=True,
            ) as media_response:
                media_response.raise_for_status()
                total_bytes = int(media_response.headers.get("content-length") or 0)
                downloaded_bytes = 0
                last_reported_percent = progress_start
                last_progress_emit_at = 0.0
                with part_path.open("wb") as handle:
                    for chunk in media_response.iter_content(chunk_size=256 * 1024):
                        if not chunk:
                            continue
                        handle.write(chunk)
                        downloaded_bytes += len(chunk)
                        if total_bytes:
                            percent = progress_start + downloaded_bytes * progress_span / total_bytes
                            clamped_percent = round(min(percent, progress_start + progress_span), 1)
                            now = time.monotonic()
                            if clamped_percent > last_reported_percent and (
                                now - last_progress_emit_at >= 0.1
                                or clamped_percent >= progress_start + progress_span
                            ):
                                progress("downloading", message, clamped_percent)
                                last_reported_percent = clamped_percent
                                last_progress_emit_at = now
                        elif time.monotonic() - last_progress_emit_at >= 0.25:
                            progress("downloading", f"{message}（已接收 {downloaded_bytes // 1024} KB）")
                            last_progress_emit_at = time.monotonic()
            part_path.replace(target_path)
        except Exception:
            part_path.unlink(missing_ok=True)
            raise

    wants_audio_only = bool(audio_url) and (
        download_behavior == "transcribe" or video_quality == "audio"
    )
    if wants_audio_only and audio_url:
        downloaded_file = output_dir / f"{safe_base_name} [{video_id}].m4a"
        progress("downloading", "已解析到抖音音频，正在下载文件", 4)
        download_stream(audio_url, downloaded_file, "正在下载抖音音频", 4, 56)
    elif audio_url:
        staged_video_path = output_dir / f"{safe_base_name} [{video_id}].video.mp4"
        staged_audio_path = output_dir / f"{safe_base_name} [{video_id}].audio.m4a"
        downloaded_file = output_dir / f"{safe_base_name} [{video_id}].mp4"
        progress("downloading", "已解析到抖音音视频，正在下载视频轨", 4)
        try:
            download_stream(play_url, staged_video_path, "正在下载抖音视频轨", 4, 40)
            download_stream(audio_url, staged_audio_path, "正在下载抖音音频轨", 44, 16)
            progress("preprocessing", "下载完成，正在合并抖音音视频", 62)
            merge_media_streams(staged_video_path, staged_audio_path, downloaded_file)
        except Exception:
            downloaded_file.unlink(missing_ok=True)
            raise
        finally:
            staged_video_path.unlink(missing_ok=True)
            staged_audio_path.unlink(missing_ok=True)
    else:
        downloaded_file = output_dir / f"{safe_base_name} [{video_id}].mp4"
        progress("downloading", "已解析到抖音视频，正在下载文件", 4)
        download_stream(play_url, downloaded_file, "正在下载抖音视频", 4, 56)

    info = {
        "id": video_id,
        "title": raw_title,
        "duration": duration or probe_media_duration_seconds(downloaded_file),
        "extractor": extractor,
        "webpage_url": webpage_url,
        "height": None,
    }
    log("info", f"Douyin media download succeeded via {extractor}.", "douyin-share")

    if video_quality == "audio" and download_behavior != "transcribe":
        audio_path = extract_audio_from_video(
            downloaded_file,
            output_dir,
            raw_title,
            percent=68,
            message="视频已下载，正在转换为音频",
        )
        downloaded_file.unlink(missing_ok=True)
        downloaded_file = audio_path

    outcome = prepare_download_outcome_from_media(
        output_dir=output_dir,
        display_name=raw_title,
        info=info,
        downloaded_file=downloaded_file,
        download_behavior=download_behavior,
        video_quality=video_quality,
        fallback_message=build_quality_fallback_message(video_quality, None, extractor),
    )
    # Keep the caller's directory valid while a download route can still fail.
    # Rename only after downloading and preprocessing have both succeeded.
    renamed_output_dir = switch_output_dir(output_dir, raw_title)
    if not same_path(output_dir, renamed_output_dir):
        outcome.output_dir = renamed_output_dir
        for field_name in ("transcript_input_path", "temp_audio_path", "downloaded_media_path"):
            media_path = getattr(outcome, field_name)
            if media_path is not None:
                setattr(outcome, field_name, renamed_output_dir / media_path.relative_to(output_dir))
        if outcome.source_media_path is not None:
            outcome.source_media_path = str(
                renamed_output_dir / Path(outcome.source_media_path).relative_to(output_dir)
            )
    return outcome


def download_douyin_via_browser(
    url: str, output_dir: Path, download_behavior: str, video_quality: str
) -> DownloadOutcome:
    video_id = resolve_douyin_video_id(url)
    if not video_id:
        fail("download_failed", "无法从抖音链接中识别视频编号。")

    browser_path = find_chromium_browser()
    if not browser_path:
        fail(
            "download_failed",
            "未检测到 Chrome、Edge 或 Chromium，无法执行抖音免 Cookie 解析。",
        )

    progress("downloading", "正在通过临时浏览器解析抖音视频", 2)
    log("info", f"Trying isolated browser fallback with {browser_path.name}.", "douyin-browser")
    capture = capture_douyin_media_via_browser(url, browser_path)
    raw_title = capture.title or f"douyin-{video_id}"
    return download_douyin_media_url(
        play_url=capture.url,
        video_id=video_id,
        raw_title=raw_title,
        output_dir=output_dir,
        download_behavior=download_behavior,
        video_quality=video_quality,
        extractor="douyin-isolated-browser",
        webpage_url=url,
        duration=None,
        request_headers={
            "User-Agent": capture.user_agent,
            "Referer": capture.referer,
        },
        audio_url=capture.audio_url,
    )


class DownloadProgressTracker:
    """Combine separate video/audio transfers instead of finishing after the first file."""
    def __init__(self, info: dict[str, Any]):
        formats = info.get("requested_formats") or [info]
        self.weights = {str(item.get("format_id") or "default"): float(item.get("filesize") or item.get("filesize_approx") or 0) for item in formats}
        if not all(self.weights.values()):
            self.weights = dict.fromkeys(self.weights, 1.0)
        self.fractions: dict[str, float] = {}

    def update(self, data: dict[str, Any]) -> float | None:
        key = str((data.get("info_dict") or {}).get("format_id") or "default")
        if key not in self.weights:
            return None
        total = data.get("total_bytes") or data.get("total_bytes_estimate") or 0
        if data.get("status") == "finished":
            fraction = 1.0
        elif total:
            fraction = min(1.0, (data.get("downloaded_bytes") or 0) / total)
        else:
            return None
        self.fractions[key] = max(self.fractions.get(key, 0), fraction)
        return round(100 * sum(self.weights[k] * self.fractions.get(k, 0) for k in self.weights) / sum(self.weights.values()), 1)


def download_media(
    url: str,
    output_dir: Path,
    download_behavior: str,
    video_quality: str,
    project_root: str = "",
    youtube_cookie_source: str = "auto",
    youtube_browser_profile: str = "",
    download_connections: int = 8,
) -> DownloadOutcome:
    if is_douyin_url(url):
        try:
            return download_douyin_via_share_page(url, output_dir, download_behavior, video_quality)
        except Exception as error:
            log("warning", f"抖音分享页直连失败，尝试临时浏览器：{error}", "douyin-share")

        try:
            return download_douyin_via_browser(url, output_dir, download_behavior, video_quality)
        except Exception as error:
            log("warning", f"临时浏览器解析失败，回退到 yt-dlp：{error}", "douyin-browser")

    import yt_dlp  # type: ignore

    progress("downloading", "正在解析链接信息", 1)

    latest_status_message = "正在下载链接内容"
    last_progress_at = time.monotonic()
    heartbeat_started_at = time.monotonic()
    heartbeat_stop = threading.Event()
    last_hook_percent = -1.0
    last_hook_emit_at = 0.0
    transfer_progress: DownloadProgressTracker | None = None

    def mark_progress(message: str | None = None) -> None:
        nonlocal latest_status_message, last_progress_at
        if message:
            latest_status_message = message
        last_progress_at = time.monotonic()

    def heartbeat() -> None:
        while not heartbeat_stop.wait(5):
            if time.monotonic() - last_progress_at < 5:
                continue

            elapsed = format_elapsed(time.monotonic() - heartbeat_started_at)
            progress("downloading", f"{latest_status_message}（已等待 {elapsed}）")

    def hook(data: dict[str, Any]) -> None:
        nonlocal last_hook_percent, last_hook_emit_at
        status = data.get("status")
        if status == "downloading":
            if download_behavior == "transcribe":
                mark_progress("正在下载转写音频")
            elif video_quality == "audio":
                mark_progress("正在下载音频文件")
            else:
                mark_progress("正在下载视频文件")
            total = data.get("total_bytes") or data.get("total_bytes_estimate") or 0
            downloaded = data.get("downloaded_bytes") or 0
            speed = data.get("speed") or 0
            eta = data.get("eta")
            details = f"{downloaded / (1024 * 1024):.1f} MB"
            if total:
                details += f" / {total / (1024 * 1024):.1f} MB"
            if speed:
                details += f" · {speed / (1024 * 1024):.1f} MB/s"
            if isinstance(eta, (int, float)) and eta >= 0:
                details += f" · 剩余 {format_elapsed(eta)}"
            mark_progress(f"{latest_status_message} · {details}")
            now = time.monotonic()
            if total:
                percent = transfer_progress.update(data) if transfer_progress else round(min(100.0, downloaded * 100 / total), 1)
                if percent is None:
                    return
                if percent > last_hook_percent and (now - last_hook_emit_at >= 0.1 or percent >= 100):
                    progress("downloading", latest_status_message, percent)
                    last_hook_percent = percent
                    last_hook_emit_at = now
            elif now - last_hook_emit_at >= 0.25:
                progress("downloading", latest_status_message)
                last_hook_emit_at = now
        elif status == "finished":
            percent = transfer_progress.update(data) if transfer_progress else None
            mark_progress("当前媒体流已下载，正在准备其余媒体或合并文件")
            progress("downloading", latest_status_message, percent)

    wants_downloaded_media = download_behavior != "transcribe"
    wants_audio_download = video_quality == "audio"
    base_options: dict[str, Any] = {
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "logger": YTDLPQuietLogger(),
        "retries": 3,
        "fragment_retries": 3,
        "socket_timeout": 20,
        "windowsfilenames": True,
        "remote_components": {"ejs:github"},
        "progress_hooks": [hook],
        "download_connections": connection_count(download_connections),
        "concurrent_fragment_downloads": connection_count(download_connections),
    }

    site_headers = build_site_http_headers(url)
    if site_headers:
        base_options["http_headers"] = site_headers
        log("info", f"Using site-specific headers for {(urlparse(url).hostname or '').lower()}", "yt-dlp")

    if is_bilibili_url(url):
        base_options["proxy"] = ""
        log("info", "B 站使用直连下载，不继承电脑的 HTTP/SOCKS 代理；路由器透明代理由路由规则决定", "download")

    cookie_file = Path(project_root) / "cookies.txt" if project_root else None
    if not is_youtube_url(url) and cookie_file and cookie_file.is_file():
        base_options["cookiefile"] = str(cookie_file)
        log("info", f"Using cookies from {cookie_file}", "yt-dlp")

    if wants_downloaded_media:
        if wants_audio_download:
            base_options["format"] = "bestaudio/best"
            base_options["postprocessors"] = [
                {
                    "key": "FFmpegExtractAudio",
                    "preferredcodec": "mp3",
                    "preferredquality": "192",
                }
            ]
        else:
            base_options["format"] = build_video_format(video_quality)
            base_options["merge_output_format"] = "mp4"
    else:
        base_options["format"] = "bestaudio/best"
        base_options["postprocessors"] = [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": "192",
            }
        ]

    js_runtimes = detect_js_runtimes()
    if js_runtimes:
        base_options["js_runtimes"] = js_runtimes
        log("info", f"Enabled yt-dlp JS runtimes: {', '.join(js_runtimes.keys())}", "yt-dlp")
    else:
        log("warning", "No supported JavaScript runtime was found for yt-dlp. Some sites may be incomplete.", "yt-dlp")

    youtube_cookiejar = None
    preview_info: dict[str, Any] | None = None
    current_output_dir = output_dir
    preview_options = {
        key: value
        for key, value in base_options.items()
        if key not in {"progress_hooks", "postprocessors"}
    }

    try:
        if is_youtube_url(url):
            preview_info, youtube_cookiejar = probe_youtube_session(
                url, preview_options, youtube_cookie_source, youtube_browser_profile, project_root
            )
        else:
            with bilibili_download_sources(), yt_dlp.YoutubeDL(preview_options) as downloader:
                preview_info = downloader.extract_info(url, download=False)

        if not wants_downloaded_media:
            preview_ext = str(preview_info.get("ext") or "").lower()
            preview_vcodec = str(preview_info.get("vcodec") or "").lower()
            if f".{preview_ext}" in AUDIO_EXTENSIONS or preview_vcodec == "none":
                base_options.pop("postprocessors", None)

        resolved_title = str(preview_info.get("title") or "").strip()
        if resolved_title:
            current_output_dir = switch_output_dir(current_output_dir, resolved_title)

        latest_status_message = summarize_remote_media(url, preview_info, download_behavior, video_quality)
        transfer_progress = DownloadProgressTracker(preview_info)
        mark_progress(latest_status_message)
        progress("downloading", latest_status_message, 3)
    except Exception as error:
        if is_youtube_url(url):
            raise

        latest_status_message = summarize_remote_media(url, None, download_behavior, video_quality)
        mark_progress(latest_status_message)
        log("warning", f"链接信息预解析失败，将直接尝试下载：{error}", "yt-dlp")
        progress("downloading", latest_status_message, 2)

    last_error: Exception | None = None
    for attempt in range(1, 4):
        try:
            heartbeat_started_at = time.monotonic()
            heartbeat_stop.clear()
            threading.Thread(target=heartbeat, daemon=True).start()

            active_options = dict(base_options)
            active_options["outtmpl"] = str(current_output_dir / "%(title).120s [%(id)s].%(ext)s")
            log("info", f"HTTP 下载最多使用 {active_options['download_connections']} 个并行连接，分段失败独立重试", "download")
            with bilibili_download_sources(lambda message: log("info", message, "download")), parallel_http_downloads(), yt_dlp.YoutubeDL(active_options) as downloader:
                if youtube_cookiejar is not None:
                    downloader.cookiejar = youtube_cookiejar
                info = downloader.extract_info(url, download=True)
            heartbeat_stop.set()

            resolved_title = str(info.get("title") or "").strip()
            if resolved_title:
                current_output_dir = switch_output_dir(current_output_dir, resolved_title)

            video_files = newest_matching_files(current_output_dir, VIDEO_EXTENSIONS)
            audio_files = newest_matching_files(current_output_dir, AUDIO_EXTENSIONS)
            downloaded_file = (
                audio_files[0]
                if wants_audio_download or (not wants_downloaded_media and audio_files)
                else video_files[0] if video_files else audio_files[0] if audio_files else None
            )

            if downloaded_file is None:
                fail("download_failed", "下载已完成，但没有找到可用的媒体文件。")

            actual_height = info.get("height")
            if isinstance(actual_height, str) and actual_height.isdigit():
                actual_height = int(actual_height)
            elif not isinstance(actual_height, int):
                actual_height = None

            return prepare_download_outcome_from_media(
                output_dir=current_output_dir,
                display_name=resolved_title or str((preview_info or {}).get("title") or downloaded_file.stem),
                info=info,
                downloaded_file=downloaded_file,
                download_behavior=download_behavior,
                video_quality=video_quality,
                fallback_message=build_quality_fallback_message(
                    video_quality,
                    actual_height,
                    str(info.get("extractor") or info.get("extractor_key") or ""),
                ),
            )
        except Exception as error:  # pragma: no cover - runtime path
            heartbeat_stop.set()
            last_error = error

            if is_youtube_url(url) and is_auth_gate_error_message(str(error)):
                fail("youtube_session_expired", "YouTube 登录状态已失效或会员权限不足，请在所选浏览器确认可以播放后重试。", str(error))

            if attempt >= 3:
                break

            log("warning", f"下载失败，准备重试（{attempt}/3）：{error}")
            progress("downloading", f"下载失败，正在重试（{attempt}/3）", 0)

    assert last_error is not None
    raise last_error


def prepare_local_media(input_path: Path, output_dir: Path, display_name: str) -> tuple[Path, Path | None]:
    if not input_path.exists():
        fail("file_not_found", "选中的本地文件不存在。", str(input_path))

    if input_path.suffix.lower() in AUDIO_EXTENSIONS:
        return input_path, None

    if input_path.suffix.lower() not in VIDEO_EXTENSIONS:
        fail("unsupported_file", "当前文件类型暂不支持处理。", str(input_path))

    extracted = extract_audio_from_video(
        input_path,
        output_dir,
        display_name,
        percent=18,
        message="正在从本地视频提取音频",
    )
    return extracted, extracted


def write_json(target: Path, payload: Any) -> None:
    target.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def compact_mapping(payload: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in payload.items() if value is not None}


def _format_subtitle_timestamp(seconds: float, *, decimal_marker: str) -> str:
    total_milliseconds = max(0, int(round(seconds * 1000)))
    hours, remainder = divmod(total_milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, milliseconds = divmod(remainder, 1_000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}{decimal_marker}{milliseconds:03d}"


def _write_srt(target: Path, segments: list[dict[str, Any]]) -> None:
    lines: list[str] = []
    for index, segment in enumerate(segments, start=1):
        start = _format_subtitle_timestamp(float(segment.get("start") or 0.0), decimal_marker=",")
        end = _format_subtitle_timestamp(float(segment.get("end") or 0.0), decimal_marker=",")
        text = str(segment.get("text") or "").strip()
        lines.extend([str(index), f"{start} --> {end}", text, ""])

    target.write_text("\n".join(lines).strip() + "\n", encoding="utf-8")


def _write_vtt(target: Path, segments: list[dict[str, Any]]) -> None:
    lines = ["WEBVTT", ""]
    for segment in segments:
        start = _format_subtitle_timestamp(float(segment.get("start") or 0.0), decimal_marker=".")
        end = _format_subtitle_timestamp(float(segment.get("end") or 0.0), decimal_marker=".")
        text = str(segment.get("text") or "").strip()
        lines.extend([f"{start} --> {end}", text, ""])

    target.write_text("\n".join(lines).strip() + "\n", encoding="utf-8")


def export_transcript_formats(
    result: dict[str, Any], output_dir: Path, display_name: str
) -> dict[str, str]:
    base_name = sanitize_name(display_name, "transcript")
    transcript_text = (result.get("text") or "").strip()
    segments = list(result.get("segments") or [])
    txt_path = output_dir / f"{base_name}.txt"
    json_path = output_dir / f"{base_name}.json"
    srt_path = output_dir / f"{base_name}.srt"
    vtt_path = output_dir / f"{base_name}.vtt"
    txt_path.write_text("\ufeff" + transcript_text, encoding="utf-8")
    write_json(json_path, result)
    _write_srt(srt_path, segments)
    _write_vtt(vtt_path, segments)

    return {
        "transcriptTxt": str(txt_path),
        "transcriptJson": str(json_path),
        "transcriptSrt": str(srt_path),
        "transcriptVtt": str(vtt_path),
    }


def clamp_progress_percent(value: float) -> float:
    return round(max(0.0, min(100.0, value)), 1)


def build_transcription_progress_message(
    current_seconds: float | None,
    total_seconds: float | None,
) -> str:
    if current_seconds is None or total_seconds is None or total_seconds <= 0:
        return "Transcribing audio"

    return f"Transcribing audio {format_elapsed(current_seconds)} / {format_elapsed(total_seconds)}"


def build_chunk_progress_message(current_chunks: int, total_chunks: int) -> str:
    if total_chunks <= 0:
        return "Transcribing audio"

    return f"Transcribing audio chunks {current_chunks} / {total_chunks}"


def create_transcription_tqdm(value_to_seconds: Callable[[float], float]) -> type:
    class WorkerProgressTqdm:
        def __init__(
            self,
            total: float | int | None = None,
            disable: bool = False,
            unit: str | None = None,
            **_: Any,
        ) -> None:
            self.total = float(total or 0.0)
            self.disable = disable
            self.unit = unit
            self.current = 0.0
            self.last_percent = -1
            self.last_emit_at = 0.0

        def __enter__(self) -> "WorkerProgressTqdm":
            return self

        def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> bool:
            self.close()
            return False

        def update(self, amount: float = 1.0) -> None:
            self.current += float(amount)
            self._emit()

        def close(self) -> None:
            self._emit(force=True)

        def _emit(self, *, force: bool = False) -> None:
            if self.disable or self.total <= 0:
                return

            current = min(max(self.current, 0.0), self.total)
            percent = clamp_progress_percent((current / self.total) * 100)
            now = time.monotonic()
            if not force:
                if percent <= self.last_percent:
                    return
                if self.last_percent >= 0 and now - self.last_emit_at < 0.1 and percent < 100:
                    return

            self.last_percent = percent
            self.last_emit_at = now
            if self.unit == "seconds":
                message = build_transcription_progress_message(
                    value_to_seconds(current),
                    value_to_seconds(self.total),
                )
            else:
                message = build_chunk_progress_message(int(round(current)), int(round(self.total)))
            progress(
                "transcribing",
                message,
                percent,
            )

    return WorkerProgressTqdm


def query_nvidia_gpu_total_memory_mb() -> int | None:
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.total", "--format=csv,noheader,nounits"],
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
    except Exception:
        return None

    lines = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    if not lines:
        return None

    try:
        return int(lines[0])
    except ValueError:
        return None


def choose_faster_whisper_batch_size(device: str, total_memory_mb: int | None) -> int:
    if device != "cuda":
        return 1

    if total_memory_mb is None:
        return 1

    if total_memory_mb >= 28_000:
        return 16
    if total_memory_mb >= 20_000:
        return 12
    if total_memory_mb >= 12_000:
        return 8
    if total_memory_mb >= 8_000:
        return 4
    return 1


def should_disable_condition_on_previous_text(model_name: str) -> bool:
    lowered = model_name.strip().lower()
    return lowered.startswith("distil-")


def transcribe_audio(audio_path: Path, model_name: str) -> dict[str, Any]:
    import whisper  # type: ignore

    progress("transcribing", f"正在加载 Whisper 模型：{model_name}", 8)
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        model = whisper.load_model(model_name)
    progress("transcribing", "正在识别语音内容", 22)
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        return model.transcribe(str(audio_path), verbose=False, fp16=False)


def transcribe_with_openai_whisper(audio_path: Path, model_name: str) -> dict[str, Any]:
    import whisper  # type: ignore

    whisper_transcribe_module = importlib.import_module("whisper.transcribe")
    progress("transcribing", f"Loading openai-whisper model: {model_name}", 0)
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        model = whisper.load_model(model_name)
    progress("transcribing", "Starting openai-whisper transcription", 0)

    progress_tqdm = create_transcription_tqdm(lambda frames: frames * 0.01)
    original_tqdm = whisper_transcribe_module.tqdm.tqdm
    whisper_transcribe_module.tqdm.tqdm = progress_tqdm
    try:
        return model.transcribe(str(audio_path), verbose=False, fp16=False)
    finally:
        whisper_transcribe_module.tqdm.tqdm = original_tqdm


def run_faster_whisper_child() -> int:
    request_path = Path(sys.argv[2])
    result_path = Path(sys.argv[3])
    payload = json.loads(request_path.read_text(encoding="utf-8"))

    configure_faster_whisper_cuda_runtime()
    from faster_whisper import BatchedInferencePipeline, WhisperModel  # type: ignore
    import faster_whisper.transcribe as faster_whisper_transcribe  # type: ignore
    from faster_whisper.transcribe import Segment, Word  # type: ignore

    model = WhisperModel(
        payload["modelPath"],
        device=payload["device"],
        compute_type=payload["computeType"],
        local_files_only=True,
    )
    batch_size = max(1, int(payload.get("batchSize") or 1))
    audio_duration_seconds = (
        float(payload["audioDurationSeconds"])
        if payload.get("audioDurationSeconds") is not None
        else None
    )
    use_batched_pipeline = bool(payload.get("useBatched")) and batch_size > 1
    transcribe_kwargs = {
        "beam_size": 5,
        "log_progress": True,
        "without_timestamps": False,
        "vad_filter": bool(payload.get("vadFilter")),
        "condition_on_previous_text": bool(payload.get("conditionOnPreviousText", True)),
    }
    if payload.get("language"):
        transcribe_kwargs["language"] = str(payload["language"])
    log(
        "info",
        (
            f"Loaded faster-whisper model {payload.get('modelName') or payload['modelPath']} "
            f"from {payload['modelPath']} on {payload['device']} ({payload['computeType']}); "
            f"batched={use_batched_pipeline}, batch_size={batch_size}, "
            f"vad_filter={transcribe_kwargs['vad_filter']}, "
            f"condition_on_previous_text={transcribe_kwargs['condition_on_previous_text']}"
        ),
        "transcription",
    )
    progress("transcribing", "Starting faster-whisper transcription", 0)
    try:
        if use_batched_pipeline:
            class WorkerBatchedInferencePipeline(BatchedInferencePipeline):
                def _batched_segments_generator(  # type: ignore[override]
                    self,
                    features,
                    tokenizer,
                    chunks_metadata,
                    batch_size,
                    options,
                    log_progress,
                ):
                    total_duration = audio_duration_seconds or max(
                        (
                            float(segment.get("end") or 0.0) / 16000.0
                            for chunk in chunks_metadata
                            for segment in (chunk.get("segments") or [])
                            if isinstance(segment, dict)
                        ),
                        default=sum(float(chunk.get("duration") or 0.0) for chunk in chunks_metadata),
                    )
                    processed_duration = 0.0
                    processed_chunks = 0
                    seg_idx = 0

                    for i in range(0, len(features), batch_size):
                        batch_chunks_metadata = chunks_metadata[i : i + batch_size]
                        results = self.forward(
                            features[i : i + batch_size],
                            tokenizer,
                            batch_chunks_metadata,
                            options,
                        )

                        for result, chunk_metadata in zip(results, batch_chunks_metadata):
                            for segment in result:
                                seg_idx += 1
                                yield Segment(
                                    seek=segment["seek"],
                                    id=seg_idx,
                                    text=segment["text"],
                                    start=round(segment["start"], 3),
                                    end=round(segment["end"], 3),
                                    words=(
                                        None
                                        if not options.word_timestamps
                                        else [Word(**word) for word in segment["words"]]
                                    ),
                                    tokens=segment["tokens"],
                                    avg_logprob=segment["avg_logprob"],
                                    no_speech_prob=segment["no_speech_prob"],
                                    compression_ratio=segment["compression_ratio"],
                                    temperature=options.temperatures[0],
                                )

                            processed_chunks += 1
                            chunk_end_seconds = max(
                                (
                                    float(segment.get("end") or 0.0) / 16000.0
                                    for segment in (chunk_metadata.get("segments") or [])
                                    if isinstance(segment, dict)
                                ),
                                default=processed_duration + float(chunk_metadata.get("duration") or 0.0),
                            )
                            processed_duration = max(processed_duration, chunk_end_seconds)
                            if log_progress and total_duration > 0:
                                progress(
                                    "transcribing",
                                    build_transcription_progress_message(processed_duration, total_duration),
                                    clamp_progress_percent((processed_duration / total_duration) * 100),
                                )
                            elif log_progress:
                                progress(
                                    "transcribing",
                                    build_chunk_progress_message(processed_chunks, len(chunks_metadata)),
                                    clamp_progress_percent((processed_chunks / max(1, len(chunks_metadata))) * 100),
                                )

                    self.last_speech_timestamp = 0.0

            pipeline = WorkerBatchedInferencePipeline(model=model)
            segments, info = pipeline.transcribe(
                payload["audioPath"],
                batch_size=batch_size,
                **transcribe_kwargs,
            )
        else:
            progress_tqdm = create_transcription_tqdm(lambda seconds: seconds)
            original_tqdm = faster_whisper_transcribe.tqdm
            faster_whisper_transcribe.tqdm = progress_tqdm
            segments, info = model.transcribe(payload["audioPath"], **transcribe_kwargs)
        segment_list = list(segments)
    finally:
        if not use_batched_pipeline:
            faster_whisper_transcribe.tqdm = original_tqdm
    result_path.write_text(
        json.dumps(
            {
                "text": "".join(str(segment.text or "") for segment in segment_list).strip(),
                "language": getattr(info, "language", None),
                "language_probability": getattr(info, "language_probability", None),
                "segments": [
                    {
                        "id": index,
                        "start": float(segment.start),
                        "end": float(segment.end),
                        "text": str(segment.text or "").strip(),
                    }
                    for index, segment in enumerate(segment_list)
                ],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    os._exit(0)


def transcribe_faster_whisper_in_process(
    audio_path: Path,
    model_name: str,
    model_path: str,
    device: str,
    compute_type: str,
    batch_size: int,
    vad_filter: bool,
    condition_on_previous_text: bool,
    audio_duration_seconds: float | None,
    language: str | None,
) -> dict[str, Any]:
    from faster_whisper import BatchedInferencePipeline, WhisperModel  # type: ignore
    import faster_whisper.transcribe as faster_whisper_transcribe  # type: ignore
    from faster_whisper.transcribe import Segment, Word  # type: ignore

    cache_key = (model_path, device, compute_type)
    model = FASTER_WHISPER_MODEL_CACHE.get(cache_key)
    if model is None:
        model = WhisperModel(
            model_path,
            device=device,
            compute_type=compute_type,
            local_files_only=True,
        )
        FASTER_WHISPER_MODEL_CACHE.clear()
        FASTER_WHISPER_MODEL_CACHE[cache_key] = model

    use_batched_pipeline = device == "cuda" and batch_size > 1
    transcribe_kwargs = {
        "beam_size": 5,
        "log_progress": True,
        "without_timestamps": False,
        "vad_filter": vad_filter,
        "condition_on_previous_text": condition_on_previous_text,
    }
    if language:
        transcribe_kwargs["language"] = language
    log(
        "info",
        (
            f"Loaded faster-whisper model {model_name} "
            f"from {model_path} on {device} ({compute_type}); "
            f"batched={use_batched_pipeline}, batch_size={batch_size}, "
            f"vad_filter={transcribe_kwargs['vad_filter']}, "
            f"condition_on_previous_text={transcribe_kwargs['condition_on_previous_text']}"
        ),
        "transcription",
    )
    progress("transcribing", "Starting faster-whisper transcription", 0)
    original_tqdm = faster_whisper_transcribe.tqdm
    try:
        if use_batched_pipeline:
            class WorkerBatchedInferencePipeline(BatchedInferencePipeline):
                def _batched_segments_generator(  # type: ignore[override]
                    self,
                    features,
                    tokenizer,
                    chunks_metadata,
                    batch_size,
                    options,
                    log_progress,
                ):
                    total_duration = audio_duration_seconds or max(
                        (
                            float(segment.get("end") or 0.0) / 16000.0
                            for chunk in chunks_metadata
                            for segment in (chunk.get("segments") or [])
                            if isinstance(segment, dict)
                        ),
                        default=sum(float(chunk.get("duration") or 0.0) for chunk in chunks_metadata),
                    )
                    processed_duration = 0.0
                    processed_chunks = 0
                    seg_idx = 0

                    for i in range(0, len(features), batch_size):
                        batch_chunks_metadata = chunks_metadata[i : i + batch_size]
                        results = self.forward(
                            features[i : i + batch_size],
                            tokenizer,
                            batch_chunks_metadata,
                            options,
                        )

                        for result, chunk_metadata in zip(results, batch_chunks_metadata):
                            for segment in result:
                                seg_idx += 1
                                yield Segment(
                                    seek=segment["seek"],
                                    id=seg_idx,
                                    text=segment["text"],
                                    start=round(segment["start"], 3),
                                    end=round(segment["end"], 3),
                                    words=(
                                        None
                                        if not options.word_timestamps
                                        else [Word(**word) for word in segment["words"]]
                                    ),
                                    tokens=segment["tokens"],
                                    avg_logprob=segment["avg_logprob"],
                                    no_speech_prob=segment["no_speech_prob"],
                                    compression_ratio=segment["compression_ratio"],
                                    temperature=options.temperatures[0],
                                )

                            processed_chunks += 1
                            chunk_end_seconds = max(
                                (
                                    float(segment.get("end") or 0.0) / 16000.0
                                    for segment in (chunk_metadata.get("segments") or [])
                                    if isinstance(segment, dict)
                                ),
                                default=processed_duration + float(chunk_metadata.get("duration") or 0.0),
                            )
                            processed_duration = max(processed_duration, chunk_end_seconds)
                            if log_progress and total_duration > 0:
                                progress(
                                    "transcribing",
                                    build_transcription_progress_message(processed_duration, total_duration),
                                    clamp_progress_percent((processed_duration / total_duration) * 100),
                                )
                            elif log_progress:
                                progress(
                                    "transcribing",
                                    build_chunk_progress_message(processed_chunks, len(chunks_metadata)),
                                    clamp_progress_percent((processed_chunks / max(1, len(chunks_metadata))) * 100),
                                )

                    self.last_speech_timestamp = 0.0

            pipeline = WorkerBatchedInferencePipeline(model=model)
            segments, info = pipeline.transcribe(
                str(audio_path),
                batch_size=batch_size,
                **transcribe_kwargs,
            )
        else:
            progress_tqdm = create_transcription_tqdm(lambda seconds: seconds)
            faster_whisper_transcribe.tqdm = progress_tqdm
            segments, info = model.transcribe(str(audio_path), **transcribe_kwargs)
        segment_list = list(segments)
    finally:
        if not use_batched_pipeline:
            faster_whisper_transcribe.tqdm = original_tqdm

    return {
        "text": "".join(str(segment.text or "") for segment in segment_list).strip(),
        "language": getattr(info, "language", None),
        "language_probability": getattr(info, "language_probability", None),
        "segments": [
            {
                "id": index,
                "start": float(segment.start),
                "end": float(segment.end),
                "text": str(segment.text or "").strip(),
            }
            for index, segment in enumerate(segment_list)
        ],
    }


def transcribe_with_faster_whisper_candidate(
    audio_path: Path,
    model_name: str,
    model_path: str,
    device: str,
    compute_type: str,
    batch_size: int,
    vad_filter: bool,
    condition_on_previous_text: bool,
    audio_duration_seconds: float | None,
    language: str | None,
) -> dict[str, Any]:
    return transcribe_faster_whisper_in_process(
        audio_path,
        model_name,
        model_path,
        device,
        compute_type,
        batch_size,
        vad_filter,
        condition_on_previous_text,
        audio_duration_seconds,
        language,
    )


def transcribe_with_faster_whisper(
    audio_path: Path,
    model_name: str,
    language: str | None,
    prepared_model_path: str | None = None,
) -> dict[str, Any]:
    configure_faster_whisper_cuda_runtime()
    from faster_whisper.utils import download_model  # type: ignore

    last_error: Exception | None = None
    cpu_only = os.environ.get("WHISPER_DEVICE", "").strip().lower() == "cpu"
    total_memory_mb = None if cpu_only else query_nvidia_gpu_total_memory_mb()
    candidates = (
        [
            ("cuda", "float16"),
            ("cuda", "int8_float16"),
            ("cpu", "int8"),
            ("cpu", "float32"),
        ]
        if total_memory_mb is not None
        else [
            ("cpu", "int8"),
            ("cpu", "float32"),
        ]
    )
    condition_on_previous_text = not should_disable_condition_on_previous_text(model_name)
    vad_filter = True
    audio_duration_seconds = probe_media_duration_seconds(audio_path)
    if audio_duration_seconds is not None:
        log(
            "info",
            f"Detected source audio duration: {format_elapsed(audio_duration_seconds)}",
            "transcription",
        )

    progress(
        "transcribing",
        f"Preparing faster-whisper model files: {model_name} (first run may take a few minutes)",
        0,
    )
    if prepared_model_path:
        model_folder = Path(prepared_model_path)
        if not all((model_folder / name).is_file() and (model_folder / name).stat().st_size > 0 for name in ("model.bin", "config.json")):
            raise WorkerFailure("model_cache_missing", "已准备的模型缓存不可用，请在模型面板重试。")
        model_path = str(model_folder)
    else:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            model_path = download_model(model_name)
    log(
        "info",
        f"Resolved faster-whisper model {model_name} to {model_path}",
        "transcription",
    )

    for device, compute_type in candidates:
        try:
            batch_size = choose_faster_whisper_batch_size(device, total_memory_mb)
            progress(
                "transcribing",
                f"Loading faster-whisper model: {model_name} ({device}, {compute_type}, batch={batch_size})",
                0,
            )
            return transcribe_with_faster_whisper_candidate(
                audio_path,
                model_name,
                model_path,
                device,
                compute_type,
                batch_size,
                vad_filter,
                condition_on_previous_text,
                audio_duration_seconds,
                language,
            )
        except Exception as error:
            last_error = error
            log("warning", f"faster-whisper fallback from {device}/{compute_type}: {error}", "transcription")
            progress(
                "transcribing",
                f"faster-whisper could not start on {device} ({compute_type}), retrying another backend",
                0,
            )

    assert last_error is not None
    raise last_error


def transcribe_with_openai_whisper_optimized(
    audio_path: Path,
    model_name: str,
    language: str | None,
    prepared_model_path: str | None = None,
) -> dict[str, Any]:
    import whisper  # type: ignore

    whisper_transcribe_module = importlib.import_module("whisper.transcribe")
    cpu_only = os.environ.get("WHISPER_DEVICE", "").strip().lower() == "cpu"
    model_source = prepared_model_path or model_name
    if prepared_model_path and (not Path(prepared_model_path).is_file() or Path(prepared_model_path).stat().st_size == 0):
        raise WorkerFailure("model_cache_missing", "已准备的模型缓存不可用，请在模型面板重试。")
    cache_key = model_source + (":cpu" if cpu_only else ":auto")
    model = OPENAI_WHISPER_MODEL_CACHE.get(cache_key)
    if model is None:
        progress("transcribing", f"Loading openai-whisper model: {model_name}", 0)
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            model = whisper.load_model(model_source, device="cpu") if cpu_only else whisper.load_model(model_source)
        OPENAI_WHISPER_MODEL_CACHE.clear()
        OPENAI_WHISPER_MODEL_CACHE[cache_key] = model

    use_fp16 = str(getattr(model, "device", "cpu")).startswith("cuda")
    log(
        "info",
        f"Loaded openai-whisper model {model_name} on {getattr(model, 'device', 'unknown')} (fp16={use_fp16})",
        "transcription",
    )
    progress("transcribing", "Starting openai-whisper transcription", 0)

    progress_tqdm = create_transcription_tqdm(lambda frames: frames * 0.01)
    original_tqdm = whisper_transcribe_module.tqdm.tqdm
    whisper_transcribe_module.tqdm.tqdm = progress_tqdm
    try:
        transcribe_kwargs: dict[str, Any] = {
            "verbose": False,
            "fp16": use_fp16,
        }
        if language:
            transcribe_kwargs["language"] = language
        return model.transcribe(str(audio_path), **transcribe_kwargs)
    finally:
        whisper_transcribe_module.tqdm.tqdm = original_tqdm


def transcribe_audio(
    audio_path: Path,
    model_name: str,
    engine: str,
    language: str | None,
    prepared_model_path: str | None = None,
) -> dict[str, Any]:
    if engine == "faster-whisper":
        return transcribe_with_faster_whisper(audio_path, model_name, language, prepared_model_path)
    if engine == "whisper.cpp":
        return whisper_cpp_backend.transcribe(
            audio_path, model_name, language,
            progress_callback=lambda message, percent: progress("transcribing", message, percent),
            log_callback=lambda level, message: log(level, message, "transcription"),
        )
    if engine == "whisper":
        return transcribe_with_openai_whisper_optimized(audio_path, model_name, language, prepared_model_path)
    raise WorkerFailure("transcription_engine_invalid", f"不支持的转写引擎：{engine}")


def process_task(request: dict[str, Any]) -> None:
    global LOG_FILE, LOG_LEVEL

    output_dir = Path(request["outputDir"])
    output_dir.mkdir(parents=True, exist_ok=True)
    phase = str(request.get("phase") or "full")
    if phase not in {"full", "prepare", "transcribe"}:
        fail("invalid_phase", "任务阶段无效。")
    existing_log = output_dir / f"{sanitize_name(str(request.get('displayName') or ''), request['taskId'][:8])}.worker.log"
    LOG_FILE = existing_log if phase == "transcribe" and existing_log.is_file() else output_dir / "worker.log"
    if phase != "transcribe":
        LOG_FILE.write_text("", encoding="utf-8")
    LOG_LEVEL = str(request.get("logLevel") or "info")
    if bool(request.get("debugMode")):
        LOG_LEVEL = "debug"

    progress("preprocessing", "任务已接收，正在准备", 0)

    download_behavior = str(request.get("downloadBehavior") or "transcribe")
    video_quality = str(request.get("videoQuality") or "best")
    transcription_engine = str(request.get("transcriptionEngine") or "whisper")
    transcription_language = str(request.get("transcriptionLanguage") or "").strip() or None
    log(
        "info",
        (
            f"Transcription request engine={transcription_engine}, "
            f"model={request.get('whisperModel')}, "
            f"language={transcription_language or 'auto'}"
        ),
        "transcription",
    )

    source_path = Path(request["input"])
    display_name = request.get("displayName") or source_path.stem
    transcript_input_path: Path | None
    temp_audio_path: Path | None
    downloaded_media_path: Path | None
    source_media_path: str | None
    media_info: dict[str, Any]

    if phase == "transcribe":
        prepared = request.get("preparedMedia")
        if not isinstance(prepared, dict) or not prepared.get("transcriptInputPath") or not isinstance(prepared.get("mediaInfo"), dict):
            fail("prepared_media_missing", "媒体准备结果不完整，无法开始转写。")
        transcript_input_path = Path(prepared["transcriptInputPath"])
        temp_audio_path = Path(prepared["tempAudioPath"]) if prepared.get("tempAudioPath") else None
        downloaded_media_path = Path(prepared["downloadedMediaPath"]) if prepared.get("downloadedMediaPath") else None
        source_media_path = prepared.get("sourceMediaPath")
        media_info = prepared["mediaInfo"]
        if not transcript_input_path.is_file():
            fail("file_not_found", "已准备的转写媒体文件不存在。")
    elif request["sourceType"] == "link":
        outcome = download_media(
            request["input"],
            output_dir,
            download_behavior,
            video_quality,
            str(request.get("projectRoot") or ""),
            str(request.get("youtubeCookieSource") or "auto"),
            str(request.get("youtubeBrowserProfile") or ""),
            connection_count(request.get("downloadConnections", 8)),
        )
        output_dir = outcome.output_dir
        display_name = outcome.display_name
        transcript_input_path = outcome.transcript_input_path
        temp_audio_path = outcome.temp_audio_path
        downloaded_media_path = outcome.downloaded_media_path
        source_media_path = outcome.source_media_path
        media_info = outcome.media_info
    else:
        output_dir = switch_output_dir(output_dir, display_name)
        transcript_input_path, temp_audio_path = prepare_local_media(source_path, output_dir, display_name)
        downloaded_media_path = None
        source_media_path = str(source_path)
        media_info = {
            "extractor": "local-file",
            "webpageUrl": None,
            "durationSeconds": None,
            "requestedQuality": video_quality,
            "downloadBehavior": download_behavior,
            "downloadedKind": None,
            "downloadedExt": source_path.suffix.lower().lstrip("."),
            "qualityFallbackMessage": None,
        }

    base_name = sanitize_name(display_name, request["taskId"][:8])
    final_log_path = output_dir / f"{base_name}.worker.log"
    if LOG_FILE and LOG_FILE != final_log_path:
        LOG_FILE.replace(final_log_path)
        LOG_FILE = final_log_path

    if media_info.get("qualityFallbackMessage"):
        log("warning", str(media_info["qualityFallbackMessage"]), "download")

    if transcript_input_path is None:
        metadata_path = output_dir / f"{base_name}.task.json"
        write_json(
            metadata_path,
            {
                "taskId": request["taskId"],
                "input": request["input"],
                "displayName": display_name,
                "sourceType": request["sourceType"],
                "mediaInfo": media_info,
                "transcriptionLanguage": transcription_language or "auto",
                "language": None,
                "segments": [],
            },
        )
        progress("completed", "下载已完成", 100)
        emit(
            {
                "type": "result",
                "data": {
                    "taskId": request["taskId"],
                    "sourceType": request["sourceType"],
                    "input": request["input"],
                    "displayName": display_name,
                    "outputDir": str(output_dir),
                    "mediaInfo": media_info,
                    "language": None,
                    "transcriptText": "",
                    "transcriptSegments": [],
                    "outputFiles": compact_mapping({
                        "downloadedMedia": str(downloaded_media_path) if downloaded_media_path else None,
                        "logFile": str(LOG_FILE),
                        "metadataJson": str(metadata_path),
                        "sourceMedia": source_media_path,
                    }),
                },
            }
        )
        return

    if phase == "prepare":
        progress("preprocessing", "媒体已准备，等待转写", 100)
        emit({"type": "result", "data": {
            "taskId": request["taskId"], "sourceType": request["sourceType"], "input": request["input"],
            "displayName": display_name, "outputDir": str(output_dir), "mediaInfo": media_info,
            "transcriptText": "", "transcriptSegments": [], "outputFiles": {"logFile": str(LOG_FILE)},
            "preparedMedia": {
                "transcriptInputPath": str(transcript_input_path),
                "tempAudioPath": str(temp_audio_path) if temp_audio_path else None,
                "downloadedMediaPath": str(downloaded_media_path) if downloaded_media_path else None,
                "sourceMediaPath": source_media_path, "mediaInfo": media_info,
            },
        }})
        return

    staged_input_dir: Path | None = None
    transcription_input_path = transcript_input_path
    try:
        transcription_input_path, staged_input_dir = stage_transcription_input(
            transcript_input_path,
            str(request["taskId"]),
        )
        transcript_result = transcribe_audio(
            transcription_input_path,
            request["whisperModel"],
            transcription_engine,
            transcription_language,
            prepared_model_path=request.get("preparedModelPath"),
        )
    finally:
        if staged_input_dir is not None:
            shutil.rmtree(staged_input_dir, ignore_errors=True)
    progress("transcribing", "正在导出文本和字幕", 88)

    transcript_segments = [
        {
            "id": int(index),
            "start": float(segment.get("start") or 0.0),
            "end": float(segment.get("end") or 0.0),
            "text": str(segment.get("text") or "").strip(),
        }
        for index, segment in enumerate(transcript_result.get("segments") or [])
    ]

    exported = export_transcript_formats(transcript_result, output_dir, display_name)
    metadata_path = output_dir / f"{base_name}.task.json"
    write_json(
        metadata_path,
        {
            "taskId": request["taskId"],
            "input": request["input"],
            "displayName": display_name,
            "sourceType": request["sourceType"],
            "mediaInfo": media_info,
            "transcriptionLanguage": transcription_language or "auto",
            "language": transcript_result.get("language"),
            "segments": transcript_segments,
        },
    )

    keep_audio = bool(request.get("keepAudio"))
    if (
        not keep_audio
        and temp_audio_path
        and temp_audio_path.exists()
        and not same_path(temp_audio_path, downloaded_media_path)
    ):
        temp_audio_path.unlink(missing_ok=True)

    if (
        not keep_audio
        and request["sourceType"] == "link"
        and downloaded_media_path is None
    ):
        transcript_input_path.unlink(missing_ok=True)
        source_media_path = str(output_dir)

    output_files: dict[str, str | None] = {
        **exported,
        "downloadedMedia": str(downloaded_media_path) if downloaded_media_path else None,
        "logFile": str(LOG_FILE),
        "metadataJson": str(metadata_path),
        "sourceMedia": source_media_path,
    }
    if keep_audio and not same_path(transcript_input_path, downloaded_media_path):
        output_files["audio"] = str(transcript_input_path)

    progress("completed", "转写已完成", 100)
    emit(
        {
            "type": "result",
            "data": {
                "taskId": request["taskId"],
                "sourceType": request["sourceType"],
                "input": request["input"],
                "displayName": display_name,
                "outputDir": str(output_dir),
                "mediaInfo": media_info,
                "language": transcript_result.get("language"),
                "transcriptText": (transcript_result.get("text") or "").strip(),
                "transcriptSegments": transcript_segments,
                "outputFiles": compact_mapping(output_files),
            },
        }
    )


def serve() -> int:
    configure_stdio()

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
            process_task(request)
        except Exception as error:
            failure = classify_error(error)
            emit(
                {
                    "type": "error",
                    "code": failure.code,
                    "message": failure.message,
                    "details": failure.details,
                }
            )

    return 0


def main() -> int:
    configure_stdio()

    if len(sys.argv) > 1 and sys.argv[1] == "serve":
        return serve()

    if len(sys.argv) > 1 and sys.argv[1] == "faster-whisper-child":
        return run_faster_whisper_child()

    if len(sys.argv) > 1 and sys.argv[1] == "env-check":
        env_check()
        return 0

    try:
        request = read_request()
        process_task(request)
        return 0
    except Exception as error:  # pragma: no cover - runtime path
        failure = classify_error(error)
        emit(
            {
                "type": "error",
                "code": failure.code,
                "message": failure.message,
                "details": failure.details,
            }
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
