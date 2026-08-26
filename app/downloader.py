"""Fetch an Instagram post/reel: media files, caption and metadata.

Primary engine is instaloader (rich metadata, carousels, captions).
yt-dlp is the fallback when instaloader cannot reach the post.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import time
from pathlib import Path
from typing import Any, Callable, Optional

import requests
from PIL import Image

from .config import MEDIA_DIR, SESSION_FILE, THUMB_MAX, USER_AGENT

ProgressCb = Callable[[str, Optional[float]], None]

SHORTCODE_RE = re.compile(
    r"instagram\.com/(?:[\w.\-]+/)?(?:p|reel|reels|tv)/([A-Za-z0-9_\-]+)", re.I
)
BARE_SHORTCODE_RE = re.compile(r"^[A-Za-z0-9_\-]{5,}$")


class DownloadError(Exception):
    pass


def _noop(stage: str, pct: Optional[float] = None) -> None:
    pass


def resolve_url(url: str) -> str:
    """Follow /share/ and other redirect links to the canonical post URL."""
    if "/share/" not in url and "instagr.am" not in url:
        return url
    try:
        resp = requests.get(
            url, headers={"User-Agent": USER_AGENT}, allow_redirects=True, timeout=20
        )
        return resp.url
    except requests.RequestException:
        return url


def parse_shortcode(url: str) -> Optional[str]:
    url = url.strip()
    if not url:
        return None
    m = SHORTCODE_RE.search(url)
    if m:
        return m.group(1)
    if "instagram.com" not in url and BARE_SHORTCODE_RE.match(url):
        return url
    return None


def _ext_from_url(url: str, fallback: str) -> str:
    path = url.split("?")[0]
    ext = os.path.splitext(path)[1].lower()
    if ext in (".jpg", ".jpeg", ".png", ".webp", ".mp4", ".mov"):
        return ext
    return fallback


def _download_file(url: str, dest: Path, progress: ProgressCb, label: str) -> None:
    headers = {"User-Agent": USER_AGENT}
    with requests.get(url, headers=headers, stream=True, timeout=60) as r:
        r.raise_for_status()
        total = int(r.headers.get("Content-Length") or 0)
        done = 0
        tmp = dest.with_suffix(dest.suffix + ".part")
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(chunk_size=1 << 16):
                if not chunk:
                    continue
                f.write(chunk)
                done += len(chunk)
                if total:
                    progress(label, done / total)
        tmp.replace(dest)


def _make_thumb(src: Path, dest: Path) -> bool:
    try:
        with Image.open(src) as im:
            im = im.convert("RGB")
            im.thumbnail((THUMB_MAX, THUMB_MAX), Image.LANCZOS)
            im.save(dest, "JPEG", quality=85)
        return True
    except Exception:
        return False


def _write_sidecars(folder: Path, rec: dict[str, Any]) -> None:
    (folder / "caption.txt").write_text(rec.get("caption") or "", encoding="utf-8")
    (folder / "meta.json").write_text(
        json.dumps(rec, ensure_ascii=False, indent=2), encoding="utf-8"
    )


# --------------------------------------------------------------------------- #
# instaloader
# --------------------------------------------------------------------------- #

def _loader(opts: Optional[dict[str, Any]] = None):
    import instaloader

    opts = opts or {}
    L = instaloader.Instaloader(
        quiet=True,
        download_pictures=False,
        download_videos=False,
        download_video_thumbnails=False,
        download_geotags=False,
        download_comments=False,
        save_metadata=False,
        user_agent=USER_AGENT,
    )
    username = opts.get("ig_username") or os.getenv("IG_USERNAME")
    if username and SESSION_FILE.exists():
        try:
            L.load_session_from_file(username, str(SESSION_FILE))
        except Exception:
            pass
    return L


def _via_instaloader(
    shortcode: str, folder: Path, progress: ProgressCb, opts: Optional[dict[str, Any]] = None
) -> dict[str, Any]:
    import instaloader

    progress("Reading post metadata", None)
    L = _loader(opts)
    post = instaloader.Post.from_shortcode(L.context, shortcode)

    if post.typename == "GraphSidecar":
        nodes = [
            (n.video_url if n.is_video else n.display_url, "video" if n.is_video else "image")
            for n in post.get_sidecar_nodes()
        ]
        kind = "carousel"
    elif post.is_video:
        nodes = [(post.video_url, "video")]
        kind = "video"
    else:
        nodes = [(post.url, "image")]
        kind = "image"

    media: list[dict[str, str]] = []
    for i, (url, node_kind) in enumerate(nodes, start=1):
        ext = _ext_from_url(url, ".mp4" if node_kind == "video" else ".jpg")
        name = f"{i}{ext}"
        _download_file(url, folder / name, progress, f"Downloading {i}/{len(nodes)}")
        media.append({"filename": name, "kind": node_kind})

    progress("Making thumbnail", None)
    thumb_rel = None
    cover = folder / "_cover.jpg"
    try:
        _download_file(post.url, cover, _noop, "cover")
        if _make_thumb(cover, folder / "thumb.jpg"):
            thumb_rel = f"{shortcode}/thumb.jpg"
    except Exception:
        pass
    finally:
        cover.unlink(missing_ok=True)
    if thumb_rel is None:
        first_image = next((m for m in media if m["kind"] == "image"), None)
        if first_image and _make_thumb(folder / first_image["filename"], folder / "thumb.jpg"):
            thumb_rel = f"{shortcode}/thumb.jpg"

    owner_full = None
    try:
        owner_full = post.owner_profile.full_name
    except Exception:
        pass

    return {
        "shortcode": shortcode,
        "url": f"https://www.instagram.com/p/{shortcode}/",
        "type": kind,
        "owner": post.owner_username,
        "owner_full": owner_full,
        "caption": post.caption or "",
        "hashtags": sorted(post.caption_hashtags),
        "taken_at": int(post.date_utc.timestamp()),
        "likes": post.likes,
        "comments": post.comments,
        "views": post.video_view_count if post.is_video else None,
        "media_count": len(media),
        "folder": shortcode,
        "thumb": thumb_rel,
        "source": "instaloader",
        "media": media,
    }


# --------------------------------------------------------------------------- #
# yt-dlp fallback
# --------------------------------------------------------------------------- #

def _via_ytdlp(
    shortcode: str, url: str, folder: Path, progress: ProgressCb,
    opts_in: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    import yt_dlp

    opts_in = opts_in or {}
    progress("Retrying with yt-dlp", None)

    def hook(d: dict[str, Any]) -> None:
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            if total:
                progress("Downloading", (d.get("downloaded_bytes") or 0) / total)

    opts = {
        "outtmpl": str(folder / "%(playlist_index|1)s.%(ext)s"),
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "progress_hooks": [hook],
        "http_headers": {"User-Agent": USER_AGENT},
    }
    cookies_browser = opts_in.get("cookies_browser") or os.getenv("IG_COOKIES_FROM_BROWSER")
    if cookies_browser:
        opts["cookiesfrombrowser"] = (cookies_browser,)

    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)

    entries = info.get("entries") or [info]
    media: list[dict[str, str]] = []
    for f in sorted(folder.iterdir()):
        if f.suffix.lower() in (".mp4", ".mov", ".jpg", ".jpeg", ".png", ".webp"):
            kind = "video" if f.suffix.lower() in (".mp4", ".mov") else "image"
            media.append({"filename": f.name, "kind": kind})
    if not media:
        raise DownloadError("yt-dlp downloaded no media")

    kind = "carousel" if len(media) > 1 else media[0]["kind"]
    caption = info.get("description") or ""

    thumb_rel = None
    thumb_url = entries[0].get("thumbnail") or info.get("thumbnail")
    if thumb_url:
        cover = folder / "_cover.jpg"
        try:
            _download_file(thumb_url, cover, _noop, "cover")
            if _make_thumb(cover, folder / "thumb.jpg"):
                thumb_rel = f"{shortcode}/thumb.jpg"
        except Exception:
            pass
        finally:
            cover.unlink(missing_ok=True)

    return {
        "shortcode": shortcode,
        "url": url,
        "type": kind,
        "owner": info.get("uploader_id") or info.get("uploader") or info.get("channel"),
        "owner_full": info.get("uploader"),
        "caption": caption,
        "hashtags": sorted(set(re.findall(r"#([\wЀ-ӿ]+)", caption))),
        "taken_at": info.get("timestamp") or int(time.time()),
        "likes": info.get("like_count"),
        "comments": info.get("comment_count"),
        "views": info.get("view_count"),
        "media_count": len(media),
        "folder": shortcode,
        "thumb": thumb_rel,
        "source": "yt-dlp",
        "media": media,
    }


# --------------------------------------------------------------------------- #
# public entry point
# --------------------------------------------------------------------------- #

def download_post(
    raw_url: str, progress: ProgressCb = _noop, opts: Optional[dict[str, Any]] = None
) -> dict[str, Any]:
    url = resolve_url(raw_url.strip())
    shortcode = parse_shortcode(url)
    if not shortcode:
        raise DownloadError("Not an Instagram post/reel link")

    folder = MEDIA_DIR / shortcode
    if folder.exists():
        shutil.rmtree(folder, ignore_errors=True)
    folder.mkdir(parents=True, exist_ok=True)

    first_error: Optional[Exception] = None
    try:
        rec = _via_instaloader(shortcode, folder, progress, opts)
    except Exception as exc:  # noqa: BLE001 - any failure falls through to yt-dlp
        first_error = exc
        for f in folder.iterdir():
            f.unlink(missing_ok=True)
        try:
            rec = _via_ytdlp(shortcode, url, folder, progress, opts)
        except Exception as exc2:  # noqa: BLE001
            shutil.rmtree(folder, ignore_errors=True)
            raise DownloadError(f"{type(exc).__name__}: {exc} | yt-dlp: {exc2}") from exc2

    if first_error is not None:
        rec["fallback_reason"] = f"{type(first_error).__name__}: {first_error}"
    _write_sidecars(folder, rec)
    return rec
