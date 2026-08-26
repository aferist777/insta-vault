"""Editor assets: anything that can land on the timeline.

An asset is a folder under `assets/<id>/` holding the derived files (proxy,
poster, filmstrip, waveform peaks) and `asset.json`. Local imports are copied in;
vault-sourced assets only reference `media/…` so nothing is duplicated.

Audio extracted from a saved reel becomes a first-class asset of its own, so it
stays usable in every project even if the original post is later deleted.
"""
from __future__ import annotations

import json
import shutil
import time
from pathlib import Path
from typing import Any, Optional

from . import media_tools as mt
from .config import ASSETS_DIR, MEDIA_DIR

ProgressCb = mt.ProgressCb


def _noop(stage: str, pct: Optional[float] = None) -> None:
    pass


def _new_id(prefix: str) -> str:
    return f"{prefix}{int(time.time() * 1000):x}"


def _write(asset: dict[str, Any]) -> dict[str, Any]:
    (ASSETS_DIR / asset["id"] / "asset.json").write_text(
        json.dumps(asset, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return asset


def _derive(asset: dict[str, Any], src: Path, folder: Path, progress: ProgressCb) -> None:
    """Build proxy / poster / filmstrip / peaks for a source file."""
    kind = asset["kind"]
    info = mt.probe(src)
    asset.update(
        duration=round(info["duration"], 3),
        width=info["width"],
        height=info["height"],
        fps=info["fps"],
        has_audio=info["has_audio"],
    )

    if kind == "video":
        progress("Making proxy", 0.0)
        proxy = folder / "proxy.mp4"
        mt.make_proxy(src, proxy, info["duration"], progress)
        asset["proxy"] = f"{asset['id']}/proxy.mp4"
        progress("Making poster", None)
        if mt.make_poster(src, folder / "poster.jpg"):
            asset["poster"] = f"{asset['id']}/poster.jpg"
        progress("Making filmstrip", None)
        if mt.make_filmstrip(src, folder / "strip.jpg", info["duration"]):
            asset["strip"] = f"{asset['id']}/strip.jpg"
        if info["has_audio"]:
            progress("Reading waveform", None)
            if mt.waveform_peaks(src, folder / "peaks.json", info["duration"]):
                asset["peaks"] = f"{asset['id']}/peaks.json"
    elif kind == "image":
        progress("Making poster", None)
        if mt.make_poster(src, folder / "poster.jpg"):
            asset["poster"] = f"{asset['id']}/poster.jpg"
        asset["duration"] = 0.0          # stills get their length on the timeline
    elif kind == "audio":
        progress("Reading waveform", None)
        if mt.waveform_peaks(src, folder / "peaks.json", info["duration"]):
            asset["peaks"] = f"{asset['id']}/peaks.json"


def import_local(path: Path, progress: ProgressCb = _noop) -> dict[str, Any]:
    """Copy a file from disk into the asset library and prepare its derivatives."""
    if not path.is_file():
        raise FileNotFoundError(str(path))
    kind = mt.kind_of(path)
    if kind == "other":
        raise ValueError(f"Unsupported file type: {path.suffix or path.name}")

    asset_id = _new_id("a")
    folder = ASSETS_DIR / asset_id
    folder.mkdir(parents=True, exist_ok=True)
    progress("Copying file", None)
    dst = folder / f"original{path.suffix.lower()}"
    shutil.copy2(path, dst)

    asset: dict[str, Any] = {
        "id": asset_id,
        "kind": kind,
        "name": path.stem,
        "origin": "local",
        "src": f"{asset_id}/{dst.name}",
        "src_path": str(path),
        "created_at": int(time.time()),
    }
    _derive(asset, dst, folder, progress)
    return _write(asset)


def from_vault(shortcode: str, filename: str, mode: str = "media",
               name: str = "", progress: ProgressCb = _noop) -> dict[str, Any]:
    """Register a saved post's file as an asset.

    mode="media"  — reference media/… in place, only derivatives are created.
    mode="audio"  — extract the audio track into a standalone, reusable asset.
    """
    source = MEDIA_DIR / shortcode / filename
    if not source.is_file():
        raise FileNotFoundError(f"{shortcode}/{filename}")

    asset_id = _new_id("s" if mode == "audio" else "v")
    folder = ASSETS_DIR / asset_id
    folder.mkdir(parents=True, exist_ok=True)

    if mode == "audio":
        info = mt.probe(source)
        if not info["has_audio"]:
            shutil.rmtree(folder, ignore_errors=True)
            raise ValueError("This post has no audio track")
        out = folder / "audio.m4a"
        progress("Extracting audio", 0.0)
        mt.extract_audio(source, out, info["duration"], progress)
        asset = {
            "id": asset_id,
            "kind": "audio",
            "name": name or f"{shortcode} audio",
            "origin": "extracted",
            "from_post": shortcode,
            "src": f"{asset_id}/audio.m4a",
            "created_at": int(time.time()),
        }
        _derive(asset, out, folder, progress)
        return _write(asset)

    asset = {
        "id": asset_id,
        "kind": mt.kind_of(source),
        "name": name or f"{shortcode}/{filename}",
        "origin": "vault",
        "from_post": shortcode,
        "src": None,                       # served straight from /media
        "media_url": f"{shortcode}/{filename}",
        "created_at": int(time.time()),
    }
    _derive(asset, source, folder, progress)
    return _write(asset)


def extract_range(asset_id: str, start: float, end: float, name: str = "",
                  progress: ProgressCb = _noop) -> dict[str, Any]:
    """Lift the sound out of a fragment into a library entry of its own.

    Deliberately carries no `from_post`: music pulled out of a post outlives that
    post, and deleting the post must not take it along.
    """
    meta = ASSETS_DIR / str(asset_id) / "asset.json"
    if not meta.exists():
        raise FileNotFoundError("unknown asset")
    src_asset = json.loads(meta.read_text(encoding="utf-8"))
    source = (ASSETS_DIR / src_asset["src"]) if src_asset.get("src") else \
             (MEDIA_DIR / src_asset["media_url"]) if src_asset.get("media_url") else None
    if not source or not source.is_file():
        raise FileNotFoundError("the source file is missing")

    info = mt.probe(source)
    if not info["has_audio"]:
        raise ValueError("this clip has no audio track")

    span = max(0.1, float(end) - float(start))
    new_id = _new_id("s")
    folder = ASSETS_DIR / new_id
    folder.mkdir(parents=True, exist_ok=True)
    out = folder / "audio.m4a"
    progress("Extracting audio", 0.0)
    mt.extract_audio(source, out, info["duration"], progress, start=float(start), span=span)

    asset = {
        "id": new_id,
        "kind": "audio",
        "name": name or f"{src_asset.get('name', 'clip')} · audio",
        "origin": "extracted",
        "standalone": True,              # a library entry in its own right
        "src": f"{new_id}/audio.m4a",
        "created_at": int(time.time()),
    }
    _derive(asset, out, folder, progress)
    return _write(asset)


def source_of(asset: dict[str, Any]) -> Optional[Path]:
    """Where this asset's own file lives, whatever kind of asset it is."""
    if asset.get("src"):
        return ASSETS_DIR / asset["src"]
    if asset.get("media_url"):
        return MEDIA_DIR / asset["media_url"]
    return None


def health(asset: dict[str, Any]) -> dict[str, Any]:
    """Whether the file behind this record is still there.

    A record outlives its file easily — the post it came from gets deleted, or
    the archive is cleaned by hand — and until now nothing noticed: the library
    kept offering the asset, the clip went on the timeline, and the preview drew
    a black frame with no word about why. Every list of assets now carries the
    answer, so the interface can say it out loud.
    """
    src = source_of(asset)
    proxy = ASSETS_DIR / asset["proxy"] if asset.get("proxy") else None
    return {
        **asset,
        "missing": not (src and src.exists()),
        "has_proxy": bool(proxy and proxy.exists()),
    }


def scan() -> list[dict[str, Any]]:
    """Rebuild the asset list from disk (same role as Rescan for the archive)."""
    out: list[dict[str, Any]] = []
    for folder in sorted(p for p in ASSETS_DIR.iterdir() if p.is_dir()):
        meta = folder / "asset.json"
        if not meta.exists():
            continue
        try:
            out.append(health(json.loads(meta.read_text(encoding="utf-8"))))
        except (json.JSONDecodeError, OSError):
            continue
    return out


def sweep(remove: bool = True) -> list[str]:
    """Throw out the records whose file is gone, proxy or no proxy.

    A record without its file is not an asset, it is litter: it cannot be
    rendered and it cannot be sent anywhere, and a proxy beside it only makes the
    litter look usable. Nothing here asks first — housekeeping the user has to
    perform by hand is housekeeping that never happens.
    """
    gone = [a["id"] for a in scan() if a["missing"]]
    if remove:
        for asset_id in gone:
            delete(asset_id)
    return gone


def delete(asset_id: str) -> bool:
    folder = (ASSETS_DIR / asset_id).resolve()
    if ASSETS_DIR.resolve() not in folder.parents or not folder.is_dir():
        return False
    shutil.rmtree(folder, ignore_errors=True)
    return True


def derived_from(shortcode: str) -> list[str]:
    """Assets built out of one archived post — its proxies, its extracted audio.
    Deleting the post has to take them with it, or the library keeps offering
    clips whose file no longer exists. Anything marked `standalone` is spared:
    music lifted out on purpose is the user's, not the post's."""
    return [a["id"] for a in scan()
            if a.get("from_post") == shortcode and not a.get("standalone")]
