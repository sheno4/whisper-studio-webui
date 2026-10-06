"""Bounded HTTP range downloads through yt-dlp's authenticated network layer."""
from __future__ import annotations

import contextlib
import hashlib
import json
import math
import re
import shutil
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import urlsplit

try:
    from .bilibili_download import is_official_media_url, report_selection
except ImportError:
    from bilibili_download import is_official_media_url, report_selection


class RangeUnsupported(Exception):
    pass


class ParallelDownloadError(Exception):
    pass


def connection_count(value: object) -> int:
    try:
        return max(1, min(16, int(value)))
    except (TypeError, ValueError):
        return 8


def _content_range(response: object) -> tuple[int, int, int]:
    match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", str(response.headers.get("Content-Range") or ""))
    if response.status != 206 or not match:
        raise RangeUnsupported("服务器未提供可靠的范围下载")
    return tuple(int(value) for value in match.groups())


def _error_summary(error: Exception) -> str:
    status = getattr(error, "status", None)
    return f"HTTP {status}" if status else type(error).__name__


def _make_downloader():
    from yt_dlp.downloader.http import HttpFD
    from yt_dlp.networking import Request
    from yt_dlp.utils.networking import HTTPHeaderDict

    class ParallelHttpFD(HttpFD):
        def real_download(self, filename, info_dict):
            connections = connection_count(self.params.get("download_connections", 8))
            headers = HTTPHeaderDict(info_dict.get("http_headers") or {})
            if (
                connections == 1 or filename == "-" or hasattr(filename, "write")
                or self.params.get("test") or info_dict.get("is_live")
                or info_dict.get("request_data") or info_dict.get("impersonate")
                or headers.get("Range") or info_dict.get("section_start") is not None
                or info_dict.get("section_end") is not None
            ):
                return super().real_download(filename, info_dict)

            headers["Accept-Encoding"] = "identity"
            url = info_dict["url"]

            def request_range(start, end, source_url=None, timeout=None):
                request_headers = headers.copy()
                request_headers["Range"] = f"bytes={start}-{end}"
                return self.ydl.urlopen(Request(source_url or url, headers=request_headers,
                                               extensions={"timeout": timeout} if timeout else {}))

            backups = info_dict.get("_bili_backup_urls") or []
            candidates = [url]
            if backups and is_official_media_url(url):
                candidates = list(dict.fromkeys([url] + [
                    item for item in backups if is_official_media_url(item)
                ]))[:3]
            probe_error = None
            for candidate in candidates:
                try:
                    with request_range(0, 0, candidate, 3 if len(candidates) > 1 else None) as response:
                        start, end, total = _content_range(response)
                        if (start, end) != (0, 0) or total < 1 or len(response.read(2)) != 1:
                            raise RangeUnsupported("范围探测结果不一致")
                        validator = str(response.headers.get("ETag") or response.headers.get("Last-Modified") or "")
                        verified_url = candidate
                    break
                except Exception as error:
                    probe_error = error
            else:
                self.report_warning(f"并行范围下载不可用，使用兼容下载方式（{_error_summary(probe_error)}）")
                return super().real_download(filename, info_dict)

            if total < 2 * 1024 * 1024:
                return super().real_download(filename, info_dict)

            sources = [{"url": verified_url, "validator": validator}]
            if len(candidates) > 1:
                sample_end = min(total - 1, 256 * 1024 - 1)

                def sample(candidate):
                    began = time.monotonic()
                    try:
                        with request_range(0, sample_end, candidate, 3) as response:
                            if _content_range(response) != (0, sample_end, total):
                                return None
                            data = response.read(sample_end + 1)
                            if len(data) != sample_end + 1:
                                return None
                            return {
                                "url": candidate,
                                "validator": str(response.headers.get("ETag") or response.headers.get("Last-Modified") or ""),
                                "speed": len(data) / max(0.001, time.monotonic() - began),
                            }
                    except Exception:
                        return None

                with ThreadPoolExecutor(max_workers=len(candidates), thread_name_prefix="bili-cdn") as pool:
                    sampled = [result for result in pool.map(sample, candidates) if result]
                if sampled:
                    sources = sorted(sampled, key=lambda result: result["speed"], reverse=True)
                    selected = sources[0]
                    report_selection(
                        f"B站选择官方 CDN {urlsplit(selected['url']).hostname}，"
                        f"短采样速度 {selected['speed'] / 1048576:.2f} MiB/s（{len(sources)} 个可用来源）"
                    )

            chunk_size = max(4 * 1024 * 1024, math.ceil(total / 512))
            ranges = [(start, min(total - 1, start + chunk_size - 1)) for start in range(0, total, chunk_size)]
            active_connections = min(connections, len(ranges))
            target = Path(filename)
            parts_dir = target.with_name(target.name + ".range-parts")
            parts_dir.mkdir(exist_ok=True)
            source = urlsplit(url)
            identity = hashlib.sha256(json.dumps([
                source.scheme, source.netloc, source.path, info_dict.get("id"),
                info_dict.get("format_id"), total, validator, chunk_size,
            ], ensure_ascii=False).encode()).hexdigest()
            manifest = parts_dir / "identity.json"
            previous = manifest.read_text(encoding="utf-8") if manifest.exists() else ""
            if previous != identity:
                for existing in parts_dir.glob("*.part"):
                    existing.unlink()
                for existing in parts_dir.glob("*.complete"):
                    existing.unlink()
                manifest.write_text(identity, encoding="utf-8")

            completed_bytes = [0] * len(ranges)
            for index, (start, end) in enumerate(ranges):
                complete = parts_dir / f"{index}.complete"
                partial = parts_dir / f"{index}.part"
                expected = end - start + 1
                if complete.exists() and complete.stat().st_size == expected:
                    completed_bytes[index] = expected
                elif partial.exists() and partial.stat().st_size <= expected:
                    completed_bytes[index] = partial.stat().st_size
                else:
                    complete.unlink(missing_ok=True)
                    partial.unlink(missing_ok=True)

            lock = threading.Lock()
            stop = threading.Event()
            started = time.monotonic()
            initial_bytes = sum(completed_bytes)
            last_emit = [0.0]
            self.to_screen(f"[download] 并行范围下载：{active_connections} 个连接，{len(ranges)} 个分段")

            def notify(index, count, force=False):
                with lock:
                    completed_bytes[index] = count
                    now = time.monotonic()
                    if not force and now - last_emit[0] < 0.15:
                        return
                    last_emit[0] = now
                    downloaded = sum(completed_bytes)
                    elapsed = now - started
                    speed = (downloaded - initial_bytes) / elapsed if elapsed else 0
                    self._hook_progress({
                        "status": "downloading", "downloaded_bytes": downloaded,
                        "total_bytes": total, "filename": filename,
                        "elapsed": elapsed, "speed": speed,
                        "eta": (total - downloaded) / speed if speed > 0 else None,
                    }, info_dict)

            def download_part(index, start, end):
                complete = parts_dir / f"{index}.complete"
                partial = parts_dir / f"{index}.part"
                expected = end - start + 1
                if complete.exists() and complete.stat().st_size == expected:
                    return
                retries = self.params.get("retries", 3)
                retries = 3 if retries == float("inf") else max(0, min(10, int(retries)))
                for attempt in range(retries + 1):
                    if stop.is_set():
                        return
                    offset = partial.stat().st_size if partial.exists() else 0
                    if offset == expected:
                        partial.replace(complete)
                        notify(index, expected, True)
                        return
                    try:
                        selected_source = sources[attempt % len(sources)]
                        with request_range(start + offset, end, selected_source["url"]) as response:
                            actual_start, actual_end, actual_total = _content_range(response)
                            if (actual_start, actual_end, actual_total) != (start + offset, end, total):
                                raise RangeUnsupported("服务器返回的分段位置不一致")
                            encoding = str(response.headers.get("Content-Encoding") or "identity").lower()
                            if encoding != "identity":
                                raise RangeUnsupported("范围响应使用了压缩编码")
                            response_validator = str(response.headers.get("ETag") or response.headers.get("Last-Modified") or "")
                            if selected_source["validator"] and response_validator != selected_source["validator"]:
                                raise ParallelDownloadError("下载期间媒体发生变化，请重新获取链接")
                            with partial.open("ab") as output:
                                while offset < expected and not stop.is_set():
                                    data = response.read(min(64 * 1024, expected - offset))
                                    if not data:
                                        raise ConnectionError("媒体分段提前结束")
                                    output.write(data)
                                    offset += len(data)
                                    notify(index, offset)
                        if stop.is_set():
                            return
                        partial.replace(complete)
                        notify(index, expected, True)
                        return
                    except RangeUnsupported:
                        stop.set()
                        raise
                    except Exception as error:
                        if attempt == retries:
                            stop.set()
                            raise ParallelDownloadError(f"媒体分段重试后仍失败（{_error_summary(error)}）") from None
                        if stop.wait(min(2.0, 0.3 * (attempt + 1))):
                            return

            try:
                with ThreadPoolExecutor(max_workers=active_connections, thread_name_prefix="media-range") as pool:
                    futures = [pool.submit(download_part, index, start, end) for index, (start, end) in enumerate(ranges)]
                    for future in as_completed(futures):
                        future.result()
            except RangeUnsupported:
                self.report_warning("服务器未能稳定支持范围下载，切换兼容下载方式")
                return super().real_download(filename, info_dict)

            assembled = target.with_name(target.name + ".range.part")
            with assembled.open("wb") as output:
                for index, (start, end) in enumerate(ranges):
                    complete = parts_dir / f"{index}.complete"
                    if not complete.is_file() or complete.stat().st_size != end - start + 1:
                        raise ParallelDownloadError("下载分段不完整，请重试")
                    with complete.open("rb") as source_file:
                        shutil.copyfileobj(source_file, output, 1024 * 1024)
            if assembled.stat().st_size != total:
                raise ParallelDownloadError("下载文件大小校验失败")
            self.try_rename(str(assembled), filename)
            shutil.rmtree(parts_dir)
            self._hook_progress({
                "status": "finished", "downloaded_bytes": total, "total_bytes": total,
                "filename": filename, "elapsed": time.monotonic() - started,
            }, info_dict)
            return True

    return ParallelHttpFD


@contextlib.contextmanager
def parallel_http_downloads():
    """Register only during one synchronous yt-dlp job; worker jobs use separate processes."""
    from yt_dlp.downloader import PROTOCOL_MAP

    downloader = _make_downloader()
    previous = {protocol: PROTOCOL_MAP.get(protocol) for protocol in ("http", "https")}
    PROTOCOL_MAP.update(dict.fromkeys(previous, downloader))
    try:
        yield
    finally:
        for protocol, old in previous.items():
            if old is None:
                PROTOCOL_MAP.pop(protocol, None)
            else:
                PROTOCOL_MAP[protocol] = old
