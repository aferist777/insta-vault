"""Finding the cuts inside a clip.

ffmpeg scores every frame against the one before it; a hard cut scores high, a
pan or a light change scores low. We collect every score above a floor once, and
the user then slides a threshold over that list without the file being read
again — re-scanning on every drag of a slider would be unbearable.
"""
from __future__ import annotations

import re
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from . import media_tools as mt
from .render import _asset, _source

# Everything above this is collected; the user's sensitivity then filters the list
# in the browser. It sits low on purpose: when a clip has no obvious cut the app
# lowers the sensitivity until something appears, and it can only choose from what
# was collected here. Too high a floor left nothing to lower onto.
FLOOR = 0.02

_TIME = re.compile(r"pts_time:([\d.]+)")
_SCORE = re.compile(r"lavfi\.scene_score=([\d.]+)")


_SIL_START = re.compile(r"silence_start:\s*(-?[\d.]+)")
_SIL_END = re.compile(r"silence_end:\s*(-?[\d.]+)")


def detect_silence(asset_id: str, src_in: float, src_out: float,
                   noise_db: float, min_len: float, progress) -> dict[str, Any]:
    """Quiet stretches by loudness — the other way of finding a pause.

    Where `detect` reads the picture, this reads the level: everything under
    `noise_db` for longer than `min_len` counts. It knows nothing about speech,
    which is exactly why it also catches breaths, room tone and dead air that a
    transcript never mentions.
    """
    asset = _asset(asset_id)
    src = _source(asset) if asset else None
    if not src or not Path(src).exists():
        raise FileNotFoundError("the clip's file is missing")

    span = max(0.1, float(src_out) - float(src_in))
    progress("Listening for quiet", 0.1)
    proc = subprocess.run(
        [mt.FFMPEG, "-hide_banner", "-nostats",
         "-ss", f"{float(src_in):.3f}", "-t", f"{span:.3f}", "-i", str(src),
         "-vn", "-af", f"silencedetect=noise={noise_db:g}dB:d={max(0.05, min_len):g}",
         "-f", "null", "-"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    log = proc.stderr or ""
    gaps: list[dict[str, float]] = []
    open_at: float | None = None
    for line in log.splitlines():
        m = _SIL_START.search(line)
        if m:
            open_at = max(0.0, float(m.group(1)))
            continue
        m = _SIL_END.search(line)
        if m and open_at is not None:
            gaps.append({"from": round(open_at, 3), "to": round(min(span, float(m.group(1))), 3)})
            open_at = None
    if open_at is not None:                       # quiet all the way to the end
        gaps.append({"from": round(open_at, 3), "to": round(span, 3)})

    return {"gaps": [g for g in gaps if g["to"] - g["from"] >= min_len],
            "scanned": round(span, 2), "noise_db": noise_db}


def detect(asset_id: str, src_in: float, src_out: float, progress) -> dict[str, Any]:
    """Scene scores inside one clip's own range, in seconds from its start."""
    asset = _asset(asset_id)
    src = _source(asset) if asset else None
    if not src or not Path(src).exists():
        raise FileNotFoundError("the clip's file is missing")
    if (asset.get("kind") or "") == "image":
        return {"cuts": [], "scanned": 0.0, "note": "a still has nothing to cut"}

    span = max(0.1, float(src_out) - float(src_in))
    with tempfile.TemporaryDirectory() as tmp:
        report = Path(tmp) / "scenes.txt"
        # metadata=print writes to its own file, which leaves stderr free for
        # progress. The colon in "C:/…" separates filter options, and it has to
        # survive two layers of parsing — a single backslash is still eaten and
        # ffmpeg rejects the whole chain. Two is what actually works (measured).
        target = report.as_posix().replace("\\", "/").replace(":", "\\\\:")
        args = [
            "-ss", f"{float(src_in):.3f}", "-t", f"{span:.3f}", "-i", str(src),
            "-an", "-sn",
            "-vf", f"select='gt(scene,{FLOOR})',metadata=print:file={target}",
            "-f", "null", "-",
        ]
        mt.run_ffmpeg(args, span, progress, "Looking for cuts")
        text = report.read_text(encoding="utf-8", errors="replace") if report.exists() else ""

    cuts: list[dict[str, float]] = []
    pending: float | None = None
    for line in text.splitlines():
        m = _TIME.search(line)
        if m:
            pending = float(m.group(1))
            continue
        m = _SCORE.search(line)
        if m and pending is not None:
            cuts.append({"t": round(pending, 3), "score": round(float(m.group(1)), 4)})
            pending = None

    # the first frame always "changes" against nothing — it is not a cut
    cuts = [c for c in cuts if c["t"] > 0.05]
    return {"cuts": cuts, "scanned": round(span, 2), "floor": FLOOR}
