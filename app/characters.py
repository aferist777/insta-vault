"""The character library: a whole person, kept as a portrait.

A face is a square because a face model is handed a face. A character is the
opposite errand — the video models are told outright what they want to see in
the picture they animate, *clear head, shoulders, torso view*, and Kling refuses
the job when it cannot find a body to read a pose from. So a character is kept
as a 2:3 portrait framed the way a passport photographer would frame it, and the
person fills it.

Finding that framing costs nothing extra: YuNet already says where the face is,
and where the shoulders and the torso are follows from the head. A separate
person detector would be another model, another download and another failure
mode for a rectangle that can be derived.
"""
from __future__ import annotations

import json
import random
import shutil
import time
from pathlib import Path
from typing import Any, Optional

import cv2

from . import faces
from .config import DATA_DIR

CHARS_DIR = DATA_DIR / "characters"

# 2:3 upright, and large enough for every model we send it to: Kling wants at
# least 340 px on a side, nano-banana is happier with more.
PORTRAIT_W, PORTRAIT_H = 832, 1248
THUMB_W, THUMB_H = 240, 360
RATIO = PORTRAIT_H / PORTRAIT_W                  # 1.5 — height per unit of width

# How the portrait is built from the face box. The face box already carries
# YuNet's rectangle grown by a margin, so it is roughly a head. A portrait is
# about three heads tall, with the head sitting in the top third — which is the
# framing every talking-head shot uses, and the one the models were shown.
HEADS_TALL = 3.2
HEAD_FROM_TOP = 1 / 6                            # where the face's centre lands


def portrait_box(face: dict[str, int], w: int, h: int) -> dict[str, int]:
    """The 2:3 rectangle around a face that holds head, shoulders and torso.

    Everything is derived from the face box, then pushed back inside the picture
    — and if the picture is too small to hold the whole thing, the rectangle
    shrinks rather than sticking out, because a crop that runs off the edge
    cannot be cut.
    """
    s = face["size"]
    cx, cy = face["x"] + s / 2, face["y"] + s / 2

    height = s * HEADS_TALL
    width = height / RATIO
    # never larger than the picture, in either direction, and still 2:3
    width = min(width, w, h / RATIO)
    height = width * RATIO

    left = cx - width / 2
    top = cy - height * HEAD_FROM_TOP
    left = min(max(left, 0), w - width)
    top = min(max(top, 0), h - height)
    return {"x": int(left), "y": int(top), "size": int(width), "tall": True}


def portraits(path: Path) -> list[dict[str, int]]:
    """Every person in the picture, as a portrait ready to crop, biggest first."""
    img = faces._read(path)
    if img is None:
        return []
    h, w = img.shape[:2]
    return [portrait_box(f, w, h) for f in faces.detect(path)]


# --------------------------------------------------------------------------- #
# the library
# --------------------------------------------------------------------------- #

def listing() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if not CHARS_DIR.is_dir():
        return out
    for folder in sorted(p for p in CHARS_DIR.iterdir() if p.is_dir()):
        meta = folder / "character.json"
        if not meta.exists():
            continue
        try:
            who = json.loads(meta.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        who["url"] = f"/api/characters/file/{who['id']}"
        who["thumb_url"] = f"/api/characters/file/{who['id']}?thumb=1"
        out.append(who)
    return sorted(out, key=lambda c: -c.get("created_at", 0))


def new_name() -> str:
    """A name nobody in either library has yet.

    Faces and characters share one pool on purpose: two references called
    "Reid Quill" in the same popup would be a puzzle, not a convenience.
    """
    taken = {c["name"] for c in listing()} | {f["name"] for f in faces.listing()}
    for _ in range(200):
        name = f"{random.choice(faces.FIRST)} {random.choice(faces.LAST)}"
        if name not in taken:
            return name
    return f"Character {int(time.time()) % 100000}"


def save(token: str, crop: dict[str, int], source: str = "uploaded",
         name: Optional[str] = None) -> dict[str, Any]:
    """Cut the chosen portrait out of whatever is on the bench and keep it."""
    src = faces.STAGING / f"{Path(token).name}.jpg"      # always a still
    if not src.exists():
        raise FileNotFoundError("that candidate is no longer on the bench")
    img = faces._read(src)
    if img is None:
        raise ValueError("the candidate could not be read back")
    h, w = img.shape[:2]

    width = max(24, min(int(crop.get("size", w)), w))
    height = min(int(width * RATIO), h)
    width = int(height / RATIO)                          # keep 2:3 after any clamp
    x = max(0, min(int(crop.get("x", 0)), w - width))
    y = max(0, min(int(crop.get("y", 0)), h - height))
    cut = cv2.resize(img[y:y + height, x:x + width], (PORTRAIT_W, PORTRAIT_H),
                     interpolation=cv2.INTER_AREA)

    char_id = f"c{int(time.time() * 1000):x}"
    folder = CHARS_DIR / char_id
    faces._write(folder / "character.jpg", cut)
    faces._write(folder / "thumb.jpg",
                 cv2.resize(cut, (THUMB_W, THUMB_H), interpolation=cv2.INTER_AREA), 85)
    meta = {"id": char_id, "name": name or new_name(), "source": source,
            "created_at": int(time.time()),
            "crop": {"x": x, "y": y, "size": width, "height": height}}
    (folder / "character.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1),
                                           encoding="utf-8")
    faces._clear_bench()
    return {**meta, "url": f"/api/characters/file/{char_id}",
            "thumb_url": f"/api/characters/file/{char_id}?thumb=1"}


def file_of(char_id: str, thumb: bool = False) -> Optional[Path]:
    p = CHARS_DIR / Path(char_id).name / ("thumb.jpg" if thumb else "character.jpg")
    return p if p.exists() else None


def rename(char_id: str, name: str) -> bool:
    meta = CHARS_DIR / Path(char_id).name / "character.json"
    if not meta.exists() or not name.strip():
        return False
    who = json.loads(meta.read_text(encoding="utf-8"))
    who["name"] = name.strip()[:60]
    meta.write_text(json.dumps(who, ensure_ascii=False, indent=1), encoding="utf-8")
    return True


def remove(char_id: str) -> bool:
    folder = (CHARS_DIR / Path(char_id).name).resolve()
    if CHARS_DIR.resolve() not in folder.parents or not folder.is_dir():
        return False
    shutil.rmtree(folder, ignore_errors=True)
    return True
