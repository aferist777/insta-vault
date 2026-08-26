"""Which fonts this machine can actually set subtitles in.

Reading every font file on Windows takes a moment, so it happens **once**: the
result is cached, and later starts only compare a cheap fingerprint of the font
folders (how many files, and the newest timestamp). Nothing is parsed again
unless something actually changed, or the user asks for a rescan.

Coverage is read out of each file's character map rather than guessed from its
name — that is the only honest way to know whether a font can set Cyrillic.
"""
from __future__ import annotations

import json
import struct
import time
from pathlib import Path
from typing import Any, Optional

from .config import DATA_DIR

APP_FONTS = Path(__file__).resolve().parent.parent / "fonts"      # shipped with the app
USER_FONTS = DATA_DIR / "fonts"                                   # added by the user
CACHE = DATA_DIR / "fonts.json"

SYSTEM_DIRS = [
    Path(r"C:\Windows\Fonts"),
    Path.home() / "AppData/Local/Microsoft/Windows/Fonts",
]

# probe codepoints: a letter that only exists in that script
LATIN = ord("A")
CYRILLIC = ord("А")      # U+0410

# fonts nobody sets subtitles in
SKIP = {"wingdings", "wingdings 2", "wingdings 3", "webdings", "marlett", "symbol",
        "bookshelf symbol 7", "ms outlook", "holomdl2 assets", "segoe mdl2 assets",
        "segoe fluent icons", "segoe ui emoji", "segoe ui symbol", "opensymbol",
        "mt extra", "cambria math", "sansserifcollection", "hololens mdl2 assets"}

SUFFIXES = {".ttf", ".otf", ".ttc"}


# --------------------------------------------------------------------------- #
# a very small TrueType reader — enough for the family name and the cmap
# --------------------------------------------------------------------------- #

def _tables(data: bytes, offset: int = 0) -> dict[str, tuple[int, int]]:
    if len(data) < offset + 12:
        return {}
    tag = data[offset:offset + 4]
    if tag == b"ttcf":                       # a collection: read the first font
        count = struct.unpack(">I", data[offset + 8:offset + 12])[0]
        if not count:
            return {}
        first = struct.unpack(">I", data[offset + 12:offset + 16])[0]
        return _tables(data, first)
    num = struct.unpack(">H", data[offset + 4:offset + 6])[0]
    out: dict[str, tuple[int, int]] = {}
    for i in range(num):
        rec = offset + 12 + i * 16
        if len(data) < rec + 16:
            break
        name, _sum, off, length = struct.unpack(">4sIII", data[rec:rec + 16])
        out[name.decode("latin-1").strip()] = (off, length)
    return out


def _family(data: bytes, table: tuple[int, int]) -> Optional[str]:
    off, _len = table
    if len(data) < off + 6:
        return None
    _fmt, count, str_off = struct.unpack(">HHH", data[off:off + 6])
    best: dict[int, str] = {}
    for i in range(count):
        rec = off + 6 + i * 12
        if len(data) < rec + 12:
            break
        pid, eid, _lang, nid, length, noff = struct.unpack(">HHHHHH", data[rec:rec + 12])
        if nid not in (1, 16):
            continue
        start = off + str_off + noff
        raw = data[start:start + length]
        try:
            text = raw.decode("utf-16-be") if (pid == 3 or pid == 0) else raw.decode("latin-1")
        except UnicodeDecodeError:
            continue
        text = text.strip()
        if text and (nid not in best or pid == 3):
            best[nid] = text
    return best.get(16) or best.get(1)


def _covers(data: bytes, table: tuple[int, int], codepoints: list[int]) -> dict[int, bool]:
    """Walk the cmap subtables and answer, for each codepoint, is it in there."""
    off, _len = table
    found = {c: False for c in codepoints}
    if len(data) < off + 4:
        return found
    count = struct.unpack(">H", data[off + 2:off + 4])[0]
    subtables = []
    for i in range(count):
        rec = off + 4 + i * 8
        if len(data) < rec + 8:
            break
        pid, eid, sub_off = struct.unpack(">HHI", data[rec:rec + 8])
        if (pid, eid) in ((3, 1), (3, 10), (0, 3), (0, 4), (0, 6)):
            subtables.append(off + sub_off)

    for start in subtables:
        if len(data) < start + 4:
            continue
        fmt = struct.unpack(">H", data[start:start + 2])[0]
        if fmt == 4:
            seg_x2 = struct.unpack(">H", data[start + 6:start + 8])[0]
            seg = seg_x2 // 2
            ends = struct.unpack(f">{seg}H", data[start + 14:start + 14 + seg_x2])
            starts_at = start + 16 + seg_x2
            starts = struct.unpack(f">{seg}H", data[starts_at:starts_at + seg_x2])
            for cp in codepoints:
                if found[cp] or cp > 0xFFFF:
                    continue
                for i in range(seg):
                    if starts[i] <= cp <= ends[i]:
                        found[cp] = True
                        break
        elif fmt == 12:
            groups = struct.unpack(">I", data[start + 12:start + 16])[0]
            base = start + 16
            for g in range(min(groups, 20000)):
                rec = base + g * 12
                if len(data) < rec + 12:
                    break
                lo, hi, _gid = struct.unpack(">III", data[rec:rec + 12])
                for cp in codepoints:
                    if not found[cp] and lo <= cp <= hi:
                        found[cp] = True
        if all(found.values()):
            break
    return found


def _style(data: bytes, table: Optional[tuple[int, int]]) -> tuple[bool, bool]:
    """Bold and italic as the file itself declares them, in head.macStyle.

    The file name is not evidence: “Inter-SemiBold.ttf” and “ariblk.ttf” say
    nothing a parser can rely on, and the render has to hand ffmpeg a real file —
    it cannot fake a weight the way a browser does.
    """
    if not table:
        return (False, False)
    off, _len = table
    if len(data) < off + 46:
        return (False, False)
    mac = struct.unpack(">H", data[off + 44:off + 46])[0]
    return (bool(mac & 1), bool(mac & 2))


def read_font(path: Path) -> Optional[dict[str, Any]]:
    try:
        data = path.read_bytes()
    except OSError:
        return None
    tabs = _tables(data)
    if "name" not in tabs or "cmap" not in tabs:
        return None
    family = _family(data, tabs["name"])
    if not family:
        return None
    cover = _covers(data, tabs["cmap"], [LATIN, CYRILLIC])
    if not cover[LATIN] and not cover[CYRILLIC]:
        return None                       # icons, dingbats, and other non-text fonts
    bold, italic = _style(data, tabs.get("head"))
    return {
        "family": family,
        "file": str(path),
        "latin": cover[LATIN],
        "cyrillic": cover[CYRILLIC],
        "bold": bold,
        "italic": italic,
    }


# --------------------------------------------------------------------------- #
# the registry
# --------------------------------------------------------------------------- #

def _fingerprint() -> str:
    """Cheap enough to run on every start: file count and newest timestamp."""
    parts = []
    for folder in [*SYSTEM_DIRS, APP_FONTS, USER_FONTS]:
        if not folder.is_dir():
            parts.append(f"{folder.name}:0:0")
            continue
        files = [p for p in folder.iterdir() if p.suffix.lower() in SUFFIXES]
        newest = max((p.stat().st_mtime for p in files), default=0)
        parts.append(f"{folder.name}:{len(files)}:{int(newest)}")
    return "|".join(parts)


def _rank(entry: dict[str, Any]) -> tuple:
    """Prefer the plain weight of a family, and our own copies over system ones."""
    stem = Path(entry["file"]).stem.lower()
    bad = (entry.get("bold") or entry.get("italic")
           or any(w in stem for w in ("italic", "oblique", "light", "thin", "black", "semib")))
    return (0 if entry.get("origin") == "app" else 1, 1 if bad else 0, len(stem))


def _slot(entry: dict[str, Any]) -> str:
    if entry.get("bold") and entry.get("italic"):
        return "bold_italic"
    return "bold" if entry.get("bold") else "italic" if entry.get("italic") else "regular"


def scan(force: bool = False) -> dict[str, Any]:
    fp = _fingerprint()
    if not force and CACHE.exists():
        try:
            cached = json.loads(CACHE.read_text(encoding="utf-8"))
            if cached.get("fingerprint") == fp:
                return {**cached, "cached": True}
        except (json.JSONDecodeError, OSError):
            pass

    found: dict[str, dict[str, Any]] = {}
    faces: dict[str, dict[str, str]] = {}      # family → which file holds which weight
    for folder, origin in [(APP_FONTS, "app"), (USER_FONTS, "user"),
                           *[(d, "system") for d in SYSTEM_DIRS]]:
        if not folder.is_dir():
            continue
        for path in sorted(folder.iterdir()):
            if path.suffix.lower() not in SUFFIXES:
                continue
            info = read_font(path)
            if not info or info["family"].lower() in SKIP:
                continue
            info["origin"] = origin
            key = info["family"].lower()
            faces.setdefault(key, {}).setdefault(_slot(info), info["file"])
            if key not in found or _rank(info) < _rank(found[key]):
                found[key] = info

    # a family only offers bold or italic when it really ships that file
    for key, entry in found.items():
        entry["faces"] = {k: v for k, v in (faces.get(key) or {}).items() if k != "regular"}

    registry = {
        "fingerprint": fp,
        "scanned_at": int(time.time()),
        "families": sorted(found.values(), key=lambda f: f["family"].lower()),
    }
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    CACHE.write_text(json.dumps(registry, ensure_ascii=False), encoding="utf-8")
    return {**registry, "cached": False}


def file_for(family: str, bold: bool = False, italic: bool = False) -> Optional[str]:
    """The file the render must hand to ffmpeg for this family and weight.

    A missing weight falls back to the plain file rather than failing: the line
    is then set in the regular cut, which is what the preview is told to show
    too, so the two never disagree.
    """
    for entry in scan().get("families", []):
        if entry["family"].lower() != (family or "").lower():
            continue
        want = ("bold_italic" if bold and italic else "bold" if bold
                else "italic" if italic else "regular")
        return (entry.get("faces") or {}).get(want) or entry["file"]
    return None


def add_files(paths: list[str]) -> dict[str, Any]:
    """Copy the user's own font files in and fold them into the registry."""
    import shutil

    USER_FONTS.mkdir(parents=True, exist_ok=True)
    added, skipped = [], []
    for raw in paths:
        src = Path(raw)
        if src.suffix.lower() not in SUFFIXES or not src.is_file():
            skipped.append(src.name)
            continue
        dst = USER_FONTS / src.name
        if not dst.exists():
            shutil.copy2(src, dst)
        info = read_font(dst)
        if info:
            added.append(info["family"])
        else:
            dst.unlink(missing_ok=True)
            skipped.append(src.name)
    return {"added": added, "skipped": skipped, **scan(force=True)}
