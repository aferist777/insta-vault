"""The face library: where a reference face comes from and how it is kept.

A face reaches the library one of two ways — pulled at random from
thispersondoesnotexist, or brought in by the user — and both end up as the same
thing: one square crop, its thumbnail, and a record saying where it came from.
Square because that is what the model is handed, and because a picture of a face
that has half a room in it teaches the model about the room.

Finding the face inside a photograph is done by YuNet, the small detector that
ships inside OpenCV (models/face_detection_yunet_2023mar.onnx, 230 KB). It comes
back with every face it can see, so a group photo turns into a list to leaf
through rather than a guess.
"""
from __future__ import annotations

import json
import random
import shutil
import time
import urllib.request
from pathlib import Path
from typing import Any, Optional

import cv2
import numpy as np

from . import media_tools as mt
from .config import DATA_DIR

FACES_DIR = DATA_DIR / "faces"
STAGING = FACES_DIR / "_staging"
MODEL = Path(__file__).resolve().parent.parent / "models" / "face_detection_yunet_2023mar.onnx"

RANDOM_FACE = "https://thispersondoesnotexist.com/random-person.jpeg"
CROP = 768                      # what a saved face is stored at, square
THUMB = 240
MARGIN = 0.38                   # how much room around the detector's box to keep

# Names are given out here rather than asked of a language model: it is instant,
# it costs nothing, and a face called "Wendy Fletcher" is as useful as one called
# whatever a model would have invented.
FIRST = ["Ava", "Mia", "Zoe", "Ivy", "Nora", "Ruby", "Elsie", "Wendy", "Iris", "June",
         "Clara", "Faye", "Lena", "Maeve", "Nell", "Opal", "Pearl", "Sadie", "Tess", "Vera",
         "Adam", "Blake", "Cole", "Dean", "Emmett", "Finn", "Gus", "Hank", "Ian", "Jonah",
         "Keir", "Lyle", "Miles", "Noel", "Otis", "Percy", "Quentin", "Reid", "Silas", "Tobias"]
LAST = ["Archer", "Barlow", "Cade", "Doyle", "Ellis", "Fletcher", "Grant", "Hale", "Irving",
        "Jarvis", "Keane", "Lowell", "Mercer", "Nash", "Osborne", "Pike", "Quill", "Rhodes",
        "Sawyer", "Thorne", "Underwood", "Vance", "Whitlock", "York", "Ziegler"]

_detector = None


def _model() -> Optional[Any]:
    """One detector, made on first use — building it costs about a tenth of a second."""
    global _detector
    if _detector is None and MODEL.exists():
        _detector = cv2.FaceDetectorYN.create(str(MODEL), "", (320, 320), 0.6, 0.3, 5000)
    return _detector


def _read(path: Path) -> Optional["np.ndarray"]:
    """Read an image whose path may contain anything at all — cv2.imread cannot."""
    try:
        buf = np.fromfile(str(path), dtype=np.uint8)
        return cv2.imdecode(buf, cv2.IMREAD_COLOR)
    except (OSError, ValueError):
        return None


def _write(path: Path, img: "np.ndarray", quality: int = 92) -> None:
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if ok:
        path.parent.mkdir(parents=True, exist_ok=True)
        buf.tofile(str(path))


def _square(box: tuple[float, float, float, float], w: int, h: int) -> dict[str, int]:
    """The detector's box grown into a square that still fits inside the picture.

    A crop cut tight to the box loses the forehead and the chin, which is exactly
    what a face model wants to see; and it must stay square, because the crop is
    what gets sent.
    """
    x, y, bw, bh = box
    cx, cy = x + bw / 2, y + bh / 2
    side = max(bw, bh) * (1 + MARGIN * 2)
    side = min(side, w, h)
    left = min(max(cx - side / 2, 0), w - side)
    top = min(max(cy - side / 2, 0), h - side)
    return {"x": int(left), "y": int(top), "size": int(side)}


def detect(path: Path) -> list[dict[str, int]]:
    """Every face in the picture, as squares ready to crop, biggest first."""
    img = _read(path)
    det = _model()
    if img is None or det is None:
        return []
    h, w = img.shape[:2]
    det.setInputSize((w, h))
    _, faces = det.detect(img)
    if faces is None:
        return []
    boxes = [_square(tuple(f[:4]), w, h) for f in faces]
    return sorted(boxes, key=lambda b: -b["size"])


# --------------------------------------------------------------------------- #
# the staging bench: a candidate that has not been kept yet
# --------------------------------------------------------------------------- #

VIDEO_SUFFIXES = {".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi"}


def _clear_bench() -> None:
    STAGING.mkdir(parents=True, exist_ok=True)
    for old in STAGING.iterdir():              # one candidate at a time
        if old.is_file():
            old.unlink(missing_ok=True)


def stage_file(src: Path, progress=None) -> dict[str, Any]:
    """Put a picture — or a video to look through — on the bench."""
    _clear_bench()
    token = f"{int(time.time() * 1000):x}"

    if src.suffix.lower() in VIDEO_SUFFIXES:
        # A small copy is made once so that looking through the video afterwards
        # costs nothing: the browser seeks it locally instead of asking for a
        # frame at every twitch of the handle. The original stays where it is and
        # is only touched again for the one frame that gets kept, at full size.
        info = mt.probe(src)
        proxy = STAGING / f"{token}_proxy.mp4"
        mt.make_proxy(src, proxy, info.get("duration", 0), progress or (lambda *a, **k: None))
        (STAGING / f"{token}.json").write_text(json.dumps({"path": str(src)}), encoding="utf-8")
        return {"token": token, "kind": "video",
                "url": f"/api/faces/staged/{token}?proxy=1",
                "width": info.get("width", 0), "height": info.get("height", 0),
                "duration": info.get("duration", 0), "faces": [], "source": "uploaded"}

    img = _read(src)
    if img is None:
        raise ValueError("that file is not an image this app can read")
    dst = STAGING / f"{token}.jpg"
    _write(dst, img)
    h, w = img.shape[:2]
    return {"token": token, "kind": "image", "url": f"/api/faces/staged/{token}",
            "width": w, "height": h, "faces": detect(dst), "source": "uploaded"}


def stage_still(src: Path, at: float = 0.0) -> dict[str, Any]:
    """Put one frame of an archived file on the bench, and look at it.

    The viewer already has the picture on screen and the video already knows
    where it is paused, so there is nothing to prepare and nothing to look
    through — unlike the bench in the tool, which is handed a file it has never
    seen. A still is copied or pulled out at full size and examined at once.
    """
    _clear_bench()
    token = f"{int(time.time() * 1000):x}"
    dst = STAGING / f"{token}.jpg"
    if src.suffix.lower() in VIDEO_SUFFIXES:
        mt._run(["-y", "-ss", f"{max(0.0, float(at)):.3f}", "-i", str(src),
                 "-frames:v", "1", "-q:v", "2", str(dst)])
    else:
        img = _read(src)
        if img is None:
            raise ValueError("that file is not an image this app can read")
        _write(dst, img)
    img = _read(dst)
    if img is None:
        raise ValueError("that moment could not be read out of the file")
    h, w = img.shape[:2]
    return {"token": token, "kind": "image", "url": f"/api/faces/staged/{token}?t={at:.3f}",
            "width": w, "height": h, "at": round(float(at), 3),
            "faces": detect(dst), "source": "uploaded"}


MIN_FACE = 0.12          # of the frame's height; anything smaller is no use as a reference
SCAN_FPS = 5             # how finely the search steps through the fragment
SETTLE = 0.6             # seconds looked at past the first hit, for a better face


def first_face(src: Path, start: float, length: float, work: Path) -> Optional[dict[str, Any]]:
    """The moment a usable face first appears inside a stretch of video.

    The first frame of a fragment need not have a face in it at all — the camera
    may be elsewhere, the person may be turned away — and a face reference has to
    come from a frame where the face is actually there and big enough to copy.
    So the stretch is walked through a few frames a second, and once a face turns
    up the next half-second is looked at too: the difference between the first
    face and the best one nearby is the difference between a good swap and a
    smudge.
    """
    work.mkdir(parents=True, exist_ok=True)
    for old in work.glob("scan*.jpg"):
        old.unlink(missing_ok=True)
    mt._run(["-y", "-ss", f"{start:.3f}", "-t", f"{length:.3f}", "-i", str(src),
             "-vf", f"fps={SCAN_FPS}", "-q:v", "3", str(work / "scan%04d.jpg")])

    best: Optional[dict[str, Any]] = None
    for shot in sorted(work.glob("scan*.jpg")):
        at = start + (int(shot.stem[4:]) - 1) / SCAN_FPS
        img = _read(shot)
        if img is None:
            continue
        h = img.shape[0]
        found = [b for b in detect(shot) if b["size"] >= h * MIN_FACE]
        if not found:
            if best:                       # the run of faces has ended; keep the best of it
                break
            continue
        here = {"at": round(at, 3), "box": found[0], "file": shot}
        if best is None:
            best = here
        elif found[0]["size"] > best["box"]["size"]:
            best = here
        if best and at - best["at"] > SETTLE:
            break
    return best


def grab_frame(token: str, at: float, look: bool = True) -> dict[str, Any]:
    """Freeze one frame of the staged video, and look for faces if asked.

    Scrubbing asks for frames constantly and wants them back at once; the search
    for faces happens only when the handle has been let go and the frame has
    stood still for a moment, because that is the frame the user meant. Frames
    are pulled here rather than played in the page — an arbitrary file on disk
    is not something the app serves, and a still is all this bench needs.
    """
    ref = STAGING / f"{Path(token).name}.json"
    if not ref.exists():
        raise FileNotFoundError("no video on the bench")
    src = Path(json.loads(ref.read_text(encoding="utf-8"))["path"])
    if not src.exists():
        raise FileNotFoundError("the video is no longer where it was")
    dst = STAGING / f"{Path(token).name}.jpg"
    mt._run(["-y", "-ss", f"{max(0.0, float(at)):.3f}", "-i", str(src),
             "-frames:v", "1", "-q:v", "2", str(dst)])
    img = _read(dst)
    if img is None:
        raise ValueError("that moment could not be read out of the video")
    h, w = img.shape[:2]
    return {"token": token, "kind": "video", "at": round(float(at), 3),
            "url": f"/api/faces/staged/{token}?t={at:.3f}",
            "width": w, "height": h, "faces": detect(dst) if look else [],
            "source": "uploaded"}


def stage_random() -> dict[str, Any]:
    """A face that belongs to nobody, straight off thispersondoesnotexist."""
    STAGING.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(RANDOM_FACE, headers={
        "User-Agent": "Mozilla/5.0", "Referer": "https://thispersondoesnotexist.com/"})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
    if data[:2] != b"\xff\xd8":
        raise ValueError("thispersondoesnotexist did not hand back a picture")
    _clear_bench()
    token = f"{int(time.time() * 1000):x}"
    dst = STAGING / f"{token}.jpg"
    dst.write_bytes(data)
    img = _read(dst)
    h, w = img.shape[:2] if img is not None else (0, 0)
    return {"token": token, "kind": "image", "url": f"/api/faces/staged/{token}",
            "width": w, "height": h, "faces": detect(dst), "source": "random"}


def staged_path(token: str, proxy: bool = False) -> Optional[Path]:
    """The frame on the bench — or the small copy of the video behind it."""
    name = Path(token).name
    if proxy:
        p = STAGING / f"{name}_proxy.mp4"
        return p if p.exists() else None
    jpg = STAGING / f"{name}.jpg"
    if jpg.exists():
        return jpg
    ref = STAGING / f"{name}.json"
    if ref.exists():
        src = Path(json.loads(ref.read_text(encoding="utf-8"))["path"])
        if src.exists():
            return src
    return None


# --------------------------------------------------------------------------- #
# the library itself
# --------------------------------------------------------------------------- #

def _name_taken() -> set[str]:
    return {f["name"] for f in listing()}


def new_name() -> str:
    taken = _name_taken()
    for _ in range(200):
        name = f"{random.choice(FIRST)} {random.choice(LAST)}"
        if name not in taken:
            return name
    return f"Face {int(time.time()) % 100000}"      # the lists ran out; still unique


def listing() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if not FACES_DIR.is_dir():
        return out
    for folder in sorted(p for p in FACES_DIR.iterdir() if p.is_dir() and p.name != "_staging"):
        meta = folder / "face.json"
        if not meta.exists():
            continue
        try:
            face = json.loads(meta.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        face["url"] = f"/api/faces/file/{face['id']}"
        face["thumb_url"] = f"/api/faces/file/{face['id']}?thumb=1"
        out.append(face)
    return sorted(out, key=lambda f: -f.get("created_at", 0))


def save(token: str, crop: dict[str, int], source: str = "uploaded",
         name: Optional[str] = None) -> dict[str, Any]:
    """Cut the chosen square out of the candidate and keep it."""
    src = STAGING / f"{Path(token).name}.jpg"     # always a still, never the video
    if not src.exists():
        raise FileNotFoundError("that candidate is no longer on the bench")
    img = _read(src)
    if img is None:
        raise ValueError("the candidate could not be read back")
    h, w = img.shape[:2]
    size = max(16, min(int(crop.get("size", min(w, h))), min(w, h)))
    x = max(0, min(int(crop.get("x", 0)), w - size))
    y = max(0, min(int(crop.get("y", 0)), h - size))
    square = cv2.resize(img[y:y + size, x:x + size], (CROP, CROP), interpolation=cv2.INTER_AREA)

    face_id = f"f{int(time.time() * 1000):x}"
    folder = FACES_DIR / face_id
    _write(folder / "face.jpg", square)
    _write(folder / "thumb.jpg", cv2.resize(square, (THUMB, THUMB), interpolation=cv2.INTER_AREA), 85)
    meta = {"id": face_id, "name": name or new_name(), "source": source,
            "created_at": int(time.time()), "crop": {"x": x, "y": y, "size": size}}
    (folder / "face.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    _clear_bench()                                # kept: the bench is free again
    return {**meta, "url": f"/api/faces/file/{face_id}", "thumb_url": f"/api/faces/file/{face_id}?thumb=1"}


def file_of(face_id: str, thumb: bool = False) -> Optional[Path]:
    folder = (FACES_DIR / Path(face_id).name)
    p = folder / ("thumb.jpg" if thumb else "face.jpg")
    return p if p.exists() else None


def rename(face_id: str, name: str) -> bool:
    meta = FACES_DIR / Path(face_id).name / "face.json"
    if not meta.exists() or not name.strip():
        return False
    face = json.loads(meta.read_text(encoding="utf-8"))
    face["name"] = name.strip()[:60]
    meta.write_text(json.dumps(face, ensure_ascii=False, indent=1), encoding="utf-8")
    return True


def remove(face_id: str) -> bool:
    folder = (FACES_DIR / Path(face_id).name).resolve()
    if FACES_DIR.resolve() not in folder.parents or not folder.is_dir():
        return False
    shutil.rmtree(folder, ignore_errors=True)
    return True
