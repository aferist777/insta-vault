"""Thin ffmpeg wrapper: probing, proxies, posters, filmstrips, waveform peaks.

The binary comes from imageio-ffmpeg, so nothing has to be installed by hand.
imageio-ffmpeg ships ffmpeg only (no ffprobe), so probing parses ffmpeg's own
stderr banner.
"""
from __future__ import annotations

import json
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Callable, Optional

import imageio_ffmpeg

FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()

ProgressCb = Callable[[str, Optional[float]], None]

_NO_WINDOW = 0x08000000 if hasattr(subprocess, "CREATE_NO_WINDOW") else 0

DURATION_RE = re.compile(r"Duration:\s*(\d+):(\d+):(\d+\.?\d*)")
VIDEO_RE = re.compile(r"Stream #\d+:\d+.*?Video:.*?(\d{2,5})x(\d{2,5})")
FPS_RE = re.compile(r"(\d+(?:\.\d+)?)\s+fps")
AUDIO_RE = re.compile(r"Stream #\d+:\d+.*?Audio:")

VIDEO_EXT = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"}
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}
AUDIO_EXT = {".mp3", ".m4a", ".aac", ".wav", ".ogg", ".flac", ".opus"}


def _run(args: list[str], **kw: Any) -> subprocess.CompletedProcess:
    return subprocess.run(
        [FFMPEG, "-hide_banner", *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        creationflags=_NO_WINDOW, **kw,
    )


def kind_of(path: Path) -> str:
    ext = path.suffix.lower()
    if ext in VIDEO_EXT:
        return "video"
    if ext in IMAGE_EXT:
        return "image"
    if ext in AUDIO_EXT:
        return "audio"
    return "other"


def probe(path: Path) -> dict[str, Any]:
    """Duration / size / audio presence, parsed from ffmpeg's stderr."""
    out = _run(["-i", str(path)]).stderr
    info: dict[str, Any] = {"duration": 0.0, "width": None, "height": None, "fps": None,
                            "has_audio": bool(AUDIO_RE.search(out))}
    m = DURATION_RE.search(out)
    if m:
        h, mi, s = m.groups()
        info["duration"] = int(h) * 3600 + int(mi) * 60 + float(s)
    m = VIDEO_RE.search(out)
    if m:
        info["width"], info["height"] = int(m.group(1)), int(m.group(2))
    m = FPS_RE.search(out)
    if m:
        info["fps"] = float(m.group(1))
    return info


def run_ffmpeg(args: list[str], duration: float, progress: ProgressCb, label: str) -> None:
    """Public wrapper for callers that build their own argument list."""
    _run_with_progress(args, duration, progress, label)


def _run_with_progress(args: list[str], duration: float, progress: ProgressCb, label: str) -> None:
    """Run ffmpeg and report percentage from its -progress stream.

    stderr goes to a temp file rather than a pipe: ffmpeg can emit thousands of
    warning lines on Instagram files, and an unread stderr pipe deadlocks the
    encode once its buffer fills.
    """
    with tempfile.TemporaryFile(mode="w+", encoding="utf-8", errors="replace") as errfile:
        proc = subprocess.Popen(
            [FFMPEG, "-hide_banner", "-nostats", "-progress", "pipe:1", "-y", *args],
            stdout=subprocess.PIPE, stderr=errfile, text=True,
            encoding="utf-8", errors="replace", creationflags=_NO_WINDOW,
        )
        assert proc.stdout is not None
        for line in proc.stdout:
            if line.startswith("out_time_us=") and duration > 0:
                try:
                    done = int(line.strip().split("=")[1]) / 1_000_000
                    progress(label, max(0.0, min(1.0, done / duration)))
                except ValueError:
                    pass
        proc.wait()
        if proc.returncode != 0:
            errfile.seek(0)
            raise RuntimeError(f"ffmpeg failed: {errfile.read()[-400:].strip()}")


def make_proxy(src: Path, dst: Path, duration: float, progress: ProgressCb,
               height: int = 540) -> None:
    """Small h264 copy used for scrubbing and preview."""
    _run_with_progress(
        ["-i", str(src), "-vf", f"scale=-2:{height}", "-c:v", "libx264", "-preset", "veryfast",
         "-crf", "30", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", str(dst)],
        duration, progress, "Making proxy",
    )


def make_poster(src: Path, dst: Path, height: int = 320) -> bool:
    r = _run(["-y", "-ss", "0.1", "-i", str(src), "-frames:v", "1",
              "-vf", f"scale=-2:{height}", str(dst)])
    if not dst.exists():  # very short clips: retry from the first frame
        r = _run(["-y", "-i", str(src), "-frames:v", "1", "-vf", f"scale=-2:{height}", str(dst)])
    return dst.exists()


def make_filmstrip(src: Path, dst: Path, duration: float, frames: int = 20,
                   height: int = 48) -> bool:
    """One wide image with `frames` thumbnails — the strip drawn inside a clip."""
    if duration <= 0:
        return False
    fps = max(frames / duration, 0.01)
    _run(["-y", "-i", str(src), "-vf", f"fps={fps:.6f},scale=-2:{height},tile={frames}x1",
          "-frames:v", "1", str(dst)])
    return dst.exists()


def extract_audio(src: Path, dst: Path, duration: float, progress: ProgressCb,
                  start: float = 0.0, span: float = 0.0) -> None:
    """Whole track by default; `span` takes just that many seconds from `start`."""
    cut = ["-ss", f"{start:.3f}"] if start > 0 else []
    if span > 0:
        cut += ["-t", f"{span:.3f}"]
    _run_with_progress(
        [*cut, "-i", str(src), "-vn", "-c:a", "aac", "-b:a", "160k", str(dst)],
        span or duration, progress, "Extracting audio",
    )


def waveform_peaks(src: Path, dst: Path, duration: float, buckets: int = 1200) -> bool:
    """Decode to raw mono PCM and store normalised 0..100 peaks as json."""
    proc = subprocess.run(
        [FFMPEG, "-hide_banner", "-v", "error", "-i", str(src),
         "-ac", "1", "-ar", "8000", "-f", "s16le", "-"],
        capture_output=True, creationflags=_NO_WINDOW,
    )
    raw = proc.stdout
    if not raw:
        return False
    import array

    samples = array.array("h")
    samples.frombytes(raw[: len(raw) // 2 * 2])
    if not samples:
        return False
    size = max(1, len(samples) // buckets)
    peaks: list[int] = []
    for i in range(0, len(samples), size):
        chunk = samples[i:i + size]
        peak = max(abs(min(chunk)), abs(max(chunk))) if chunk else 0
        peaks.append(round(peak / 32768 * 100))
    dst.write_text(json.dumps(peaks), encoding="utf-8")
    return True
