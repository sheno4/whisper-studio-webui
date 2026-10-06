"""Keep official Bilibili mirror addresses attached to the same media format."""
from __future__ import annotations

import contextlib
from contextvars import ContextVar
from urllib.parse import urlsplit


_selection_logger = ContextVar("bilibili_selection_logger", default=None)
OFFICIAL_MEDIA_DOMAINS = ("bilivideo.com", "bilivideo.cn", "hdslb.com")


def is_official_media_url(url: object) -> bool:
    if not isinstance(url, str):
        return False
    try:
        parsed = urlsplit(url)
        host = (parsed.hostname or "").lower()
        return parsed.scheme in ("http", "https") and parsed.username is None and any(
            host == domain or host.endswith("." + domain) for domain in OFFICIAL_MEDIA_DOMAINS
        )
    except ValueError:
        return False


def attach_official_mirrors(formats: list[dict], play_info: dict) -> list[dict]:
    dash = play_info.get("dash") or {}
    media = list(dash.get("audio") or []) + list(dash.get("video") or [])
    media.extend((dash.get("dolby") or {}).get("audio") or [])
    flac = (dash.get("flac") or {}).get("audio")
    if isinstance(flac, dict):
        media.append(flac)
    media.extend(play_info.get("durl") or [])
    mirrors = {}
    for item in media:
        if not isinstance(item, dict):
            continue
        base = item.get("baseUrl") or item.get("base_url") or item.get("url")
        if not is_official_media_url(base):
            continue
        candidates = item.get("backupUrl") or item.get("backup_url") or []
        if not isinstance(candidates, (list, tuple)):
            continue
        mirrors[base] = list(dict.fromkeys(
            candidate for candidate in candidates if is_official_media_url(candidate) and candidate != base
        ))[:2]
    for media_format in formats:
        # Multi-fragment FLVs keep their existing downloader; each fragment is distinct.
        backups = mirrors.get(media_format.get("url"))
        if backups and not media_format.get("fragments"):
            media_format["_bili_backup_urls"] = backups
    return formats


def report_selection(message: str) -> None:
    callback = _selection_logger.get()
    if callback:
        callback(message)


@contextlib.contextmanager
def bilibili_download_sources(logger=None):
    from yt_dlp.extractor.bilibili import BilibiliBaseIE

    original = BilibiliBaseIE.extract_formats

    def extract_formats(extractor, play_info):
        return attach_official_mirrors(original(extractor, play_info), play_info)

    token = _selection_logger.set(logger)
    BilibiliBaseIE.extract_formats = extract_formats
    try:
        yield
    finally:
        BilibiliBaseIE.extract_formats = original
        _selection_logger.reset(token)
