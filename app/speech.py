"""Speech to text, locally or through Groq.

Local work is done by faster-whisper: it runs on CTranslate2 rather than torch,
so it stays a small install and works on the processor alone. It is *not* part of
requirements.txt — nobody should download it who never presses Transcribe. This
module reports what is present and installs it on request.

Transcription itself arrives with the Transcribe action; this is the plumbing
Preferences needs to show an honest state.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from typing import Any

from .config import DATA_DIR

# what the user can pick, with the download size they pay for on first use
MODELS = [
    ("tiny", "Tiny · 75 MB · rough, instant"),
    ("base", "Base · 145 MB"),
    ("small", "Small · 480 MB · good default"),
    ("medium", "Medium · 1.5 GB"),
    ("large-v3", "Large v3 · 3 GB · best, slow on a laptop"),
]

MODEL_DIR = DATA_DIR / "whisper"


def _import_ok() -> tuple[bool, str]:
    try:
        import faster_whisper  # noqa: F401
        return True, getattr(faster_whisper, "__version__", "installed")
    except ImportError:
        return False, ""


def _cuda_ok() -> bool:
    """CTranslate2 only reports usable devices once it is installed."""
    try:
        import ctranslate2
        return ctranslate2.get_cuda_device_count() > 0
    except Exception:      # noqa: BLE001 — any failure means "no cuda for us"
        return False


def _downloaded() -> list[str]:
    if not MODEL_DIR.exists():
        return []
    names = []
    for p in MODEL_DIR.iterdir():
        # huggingface caches as models--Systran--faster-whisper-<size>
        if p.is_dir() and "faster-whisper-" in p.name:
            names.append(p.name.split("faster-whisper-")[-1])
    return sorted(names)


def status() -> dict[str, Any]:
    installed, version = _import_ok()
    return {
        "installed": installed,
        "version": version,
        "cuda": _cuda_ok() if installed else False,
        "models": _downloaded(),
        "model_dir": str(MODEL_DIR),
        "models_available": [{"id": m, "label": l} for m, l in MODELS],
    }


def install(progress) -> dict[str, Any]:
    """pip install faster-whisper into the running environment."""
    if _import_ok()[0]:
        return {"already": True, **status()}

    progress("Downloading faster-whisper", 0.05)
    proc = subprocess.Popen(
        [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "faster-whisper"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8",
        errors="replace", creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    tail: list[str] = []
    for line in proc.stdout or []:
        line = line.rstrip()
        if not line:
            continue
        tail = [*tail[-4:], line]
        if line.startswith(("Collecting", "Downloading", "Installing", "Successfully")):
            progress(line[:70], None)
    if proc.wait() != 0:
        raise RuntimeError("pip failed:\n" + "\n".join(tail))

    # a fresh install is not importable in this interpreter until the path cache
    # is dropped, and the user should not have to restart the app for it
    import importlib
    import site
    importlib.reload(site)
    importlib.invalidate_caches()

    ok, _ = _import_ok()
    if not ok:
        return {"restart_needed": True, **status()}
    return {"installed_now": True, **status()}


def model_path(name: str) -> Path:
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    return MODEL_DIR
