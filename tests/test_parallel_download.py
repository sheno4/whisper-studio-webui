import re
import socket
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

import yt_dlp
from yt_dlp.downloader import PROTOCOL_MAP, get_suitable_downloader

from python.parallel_download import ParallelDownloadError, parallel_http_downloads
from python import parallel_download
from python.bilibili_download import attach_official_mirrors, bilibili_download_sources, is_official_media_url


class QuietLogger:
    def debug(self, message):
        pass

    warning = debug
    error = debug


class RangeFixture:
    def __init__(self, *, ignore_range=False, interrupt=False, start_delay=0.04):
        self.data = bytes(range(256)) * (12 * 1024 * 1024 // 256)
        self.ignore_range = ignore_range
        self.interrupt = interrupt
        self.start_delay = start_delay
        self.requests = []
        self.lock = threading.Lock()
        self.active = 0
        self.max_active = 0
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                with fixture.lock:
                    fixture.requests.append((self.headers.get("Range"), self.headers.get("X-Fixture-Auth")))
                if self.headers.get("X-Fixture-Auth") != "authorized":
                    self.send_error(403)
                    return
                match = re.fullmatch(r"bytes=(\d+)-(\d+)", self.headers.get("Range") or "")
                if match and not fixture.ignore_range:
                    start, end = (int(value) for value in match.groups())
                    self.send_response(206)
                    self.send_header("Content-Range", f"bytes {start}-{end}/{len(fixture.data)}")
                else:
                    start, end = 0, len(fixture.data) - 1
                    self.send_response(200)
                self.send_header("Content-Length", str(end - start + 1))
                self.send_header("ETag", '"fixture-v1"')
                self.end_headers()
                with fixture.lock:
                    fixture.active += 1
                    fixture.max_active = max(fixture.max_active, fixture.active)
                    disconnect = fixture.interrupt and start == 0 and end > 1024 * 1024
                    if disconnect:
                        fixture.interrupt = False
                try:
                    if end > start:
                        time.sleep(fixture.start_delay)
                    finish = min(end + 1, start + 256 * 1024) if disconnect else end + 1
                    for offset in range(start, finish, 64 * 1024):
                        self.wfile.write(fixture.data[offset:min(finish, offset + 64 * 1024)])
                        self.wfile.flush()
                        if end > start:
                            time.sleep(0.001)
                    if disconnect:
                        self.connection.shutdown(socket.SHUT_RDWR)
                        self.connection.close()
                except (BrokenPipeError, ConnectionResetError, OSError):
                    pass
                finally:
                    with fixture.lock:
                        fixture.active -= 1

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.url = f"http://127.0.0.1:{self.server.server_port}/media.bin?signature=private-fixture"

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *args):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)


class ParallelDownloadTests(unittest.TestCase):
    def download(self, url, target, *, retries=0, hooks=None, backups=None):
        options = {
            "quiet": True, "noprogress": True, "logger": QuietLogger(),
            "retries": retries, "socket_timeout": 2,
            "download_connections": 4, "proxy": "",
        }
        info = {
            "url": url, "id": "fixture", "format_id": "audio",
            "http_headers": {"X-Fixture-Auth": "authorized"},
            "_bili_backup_urls": backups or [],
        }
        with parallel_http_downloads(), yt_dlp.YoutubeDL(options) as downloader:
            implementation = get_suitable_downloader(info, options)(downloader, options)
            for hook in hooks or []:
                implementation.add_progress_hook(hook)
            return implementation.download(str(target), info)

    def test_parallel_transfer_resumes_interrupted_range_without_exposing_url(self):
        hooks = []
        before = {key: PROTOCOL_MAP.get(key) for key in ("http", "https")}
        with RangeFixture(interrupt=True) as fixture, tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "media.m4a"
            with self.assertRaises(ParallelDownloadError):
                self.download(fixture.url, target, hooks=[hooks.append])
            parts = target.with_name(target.name + ".range-parts")
            identity = (parts / "identity.json").read_text(encoding="utf-8")
            self.assertRegex(identity, r"^[0-9a-f]{64}$")
            self.assertNotIn("signature", identity)
            partial = parts / "0.part"
            resumed_offset = partial.stat().st_size
            self.assertGreater(resumed_offset, 0)
            self.assertLess(resumed_offset, 4 * 1024 * 1024)
            fixture.requests.clear()
            self.assertEqual(self.download(fixture.url, target, hooks=[hooks.append]), (True, True))
            self.assertEqual(target.read_bytes(), fixture.data)
            self.assertGreater(fixture.max_active, 1)
            self.assertIn((f"bytes={resumed_offset}-{4 * 1024 * 1024 - 1}", "authorized"), fixture.requests)
            self.assertTrue(all(auth == "authorized" for _, auth in fixture.requests))
            self.assertFalse(parts.exists())
            self.assertEqual(hooks[-1]["status"], "finished")
            self.assertEqual(hooks[-1]["total_bytes"], len(fixture.data))
            self.assertTrue(any(event.get("speed", 0) > 0 for event in hooks))
        self.assertEqual({key: PROTOCOL_MAP.get(key) for key in before}, before)

    def test_server_without_range_support_uses_authenticated_native_download(self):
        with RangeFixture(ignore_range=True) as fixture, tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "media.m4a"
            self.assertEqual(self.download(fixture.url, target), (True, True))
            self.assertEqual(target.read_bytes(), fixture.data)
            self.assertIn(("bytes=0-0", "authorized"), fixture.requests)
            self.assertIn((None, "authorized"), fixture.requests)
            self.assertFalse(target.with_name(target.name + ".range-parts").exists())

    def test_official_mirrors_keep_quality_choose_fastest_and_resume_on_next_source(self):
        base = "https://a.bilivideo.cn/media.m4s?token=fixture"
        backup = "https://b.bilivideo.com/media.m4s?token=fixture"
        original = {"url": base, "format_id": "30280", "acodec": "mp4a.40.2", "tbr": 192}
        enriched = attach_official_mirrors([dict(original)], {"dash": {"audio": [{
            "base_url": base,
            "backup_url": [backup, "https://bilivideo.com.invalid/media", backup],
        }]}})[0]
        self.assertEqual(enriched["_bili_backup_urls"], [backup])
        self.assertEqual({key: enriched[key] for key in original}, original)
        self.assertFalse(is_official_media_url("https://fakebilivideo.com/media"))
        messages = []
        with (
            RangeFixture(start_delay=0.08) as slow,
            RangeFixture(start_delay=0.003, interrupt=True) as fast,
            tempfile.TemporaryDirectory() as temporary,
            patch.object(parallel_download, "is_official_media_url", return_value=True),
            bilibili_download_sources(messages.append),
        ):
            target = Path(temporary) / "mirrored.m4a"
            self.assertEqual(self.download(slow.url, target, retries=1, backups=[fast.url]), (True, True))
            self.assertEqual(target.read_bytes(), fast.data)
            self.assertIn(("bytes=262144-4194303", "authorized"), slow.requests)
            self.assertIn(("bytes=0-4194303", "authorized"), fast.requests)
            self.assertEqual(len(messages), 1)
            self.assertIn("短采样速度", messages[0])
            self.assertNotIn("signature", messages[0])
            self.assertTrue(all(auth == "authorized" for _, auth in slow.requests + fast.requests))


if __name__ == "__main__":
    unittest.main()
