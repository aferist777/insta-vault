"""Speech in a fragment, turned into timed phrases.

Two engines, one answer shape: a list of {start, end, text} in seconds counted
from the beginning of the fragment, so the caller never has to care which one
ran. Groq is the default — it needs nothing installed and costs about four cents
an hour of audio. The local engine takes over only once the user has installed it
and picked it in Preferences.

The key travels with the request and is used once; nothing is written down here.
"""
from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any

import requests

from . import media_tools as mt
from . import speech
from .render import _asset, _source

GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions"
GROQ_MODEL = "whisper-large-v3-turbo"
TIMEOUT = 300


def _clip_audio(asset_id: str, start: float, end: float, folder: Path, progress) -> tuple[Path, float]:
    """The fragment's sound as 16 kHz mono — all any speech model wants, and a
    fraction of the size to upload."""
    asset = _asset(asset_id)
    src = _source(asset) if asset else None
    if not src or not Path(src).exists():
        raise FileNotFoundError("the clip's file is missing")
    if not mt.probe(src)["has_audio"]:
        raise ValueError("this clip has no sound to transcribe")

    span = max(0.2, float(end) - float(start))
    out = folder / "speech.wav"
    progress("Preparing the audio", 0.05)
    mt.run_ffmpeg(
        ["-ss", f"{float(start):.3f}", "-t", f"{span:.3f}", "-i", str(src),
         "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(out)],
        span, progress, "Preparing the audio",
    )
    return out, span


def _tighten(segments: list[dict[str, Any]], words: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Pull every cue onto the words it actually contains.

    A Whisper segment routinely starts before the first word is spoken — it
    swallows the pause in front of the phrase — which is why subtitles appeared
    long before the voice. The words themselves are aligned properly, so the cue
    takes its start from the first word and its end from the last.
    """
    if not words:
        return segments
    out = []
    for s in segments:
        inside = [w for w in words
                  if w["end"] > s["start"] + 0.01 and w["start"] < s["end"] - 0.01]
        if not inside:
            out.append({**s, "words": []})
            continue
        out.append({
            "start": round(min(w["start"] for w in inside), 3),
            "end": round(max(w["end"] for w in inside), 3),
            "text": s["text"],
            "words": inside,
        })
    return out


def _via_groq(path: Path, key: str, language: str, progress) -> list[dict[str, Any]]:
    if not key:
        raise ValueError("no Groq key — add one in Preferences, or switch to the local engine")
    progress("Sending to Groq", 0.4)
    # word timestamps cost a little latency and buy honest cue starts
    data = [("model", GROQ_MODEL), ("response_format", "verbose_json"),
            ("timestamp_granularities[]", "segment"), ("timestamp_granularities[]", "word")]
    if language:
        data.append(("language", language))
    with path.open("rb") as fh:
        r = requests.post(GROQ_URL, headers={"Authorization": f"Bearer {key}"},
                          files={"file": (path.name, fh, "audio/wav")}, data=data, timeout=TIMEOUT)
    if r.status_code != 200:
        try:
            note = (r.json().get("error") or {}).get("message") or r.text[:200]
        except ValueError:
            note = r.text[:200]
        raise RuntimeError(f"Groq refused the job: {note}")
    body = r.json()
    words = [{"start": float(w.get("start", 0)), "end": float(w.get("end", 0)),
              "text": (w.get("word") or "").strip()} for w in (body.get("words") or [])]
    segments = [{"start": float(s.get("start", 0)), "end": float(s.get("end", 0)),
                 "text": (s.get("text") or "").strip()} for s in (body.get("segments") or [])]
    if not segments and body.get("text"):
        # a very short clip can come back as one lump with no segmentation
        segments = [{"start": 0.0, "end": 0.0, "text": body["text"].strip()}]
    return _tighten(segments, words)


def _via_local(path: Path, model: str, device: str, language: str, progress) -> list[dict[str, Any]]:
    if not speech.status()["installed"]:
        raise RuntimeError("the local engine is not installed — install it in Preferences, or use Groq")
    from faster_whisper import WhisperModel      # noqa: PLC0415 — optional dependency

    progress(f"Loading the {model} model", 0.2)
    speech.MODEL_DIR.mkdir(parents=True, exist_ok=True)
    picked = device if device in ("cpu", "cuda") else ("cuda" if speech._cuda_ok() else "cpu")
    engine = WhisperModel(model, device=picked, compute_type="int8",
                          download_root=str(speech.MODEL_DIR))
    progress("Listening", 0.4)
    segments, _info = engine.transcribe(str(path), language=language or None,
                                        vad_filter=True, word_timestamps=True)
    out = []
    for s in segments:
        words = [{"start": float(w.start), "end": float(w.end), "text": (w.word or "").strip()}
                 for w in (getattr(s, "words", None) or [])]
        start = min((w["start"] for w in words), default=float(s.start))
        end = max((w["end"] for w in words), default=float(s.end))
        out.append({"start": round(start, 3), "end": round(end, 3),
                    "text": (s.text or "").strip(), "words": words})
    return out


def run(asset_id: str, start: float, end: float, opts: dict[str, Any], progress) -> dict[str, Any]:
    engine = (opts.get("engine") or "groq").lower()
    language = (opts.get("language") or "").strip()

    with tempfile.TemporaryDirectory() as tmp:
        wav, span = _clip_audio(asset_id, start, end, Path(tmp), progress)
        if engine == "local":
            segments = _via_local(wav, opts.get("model") or "small",
                                  opts.get("device") or "auto", language, progress)
        else:
            segments = _via_groq(wav, opts.get("key") or "", language, progress)

    # a lone unsegmented answer gets the whole fragment
    for s in segments:
        if s["end"] <= s["start"]:
            s["end"] = span
        s.setdefault("words", [])
    segments = [s for s in segments if s["text"]]
    return {"segments": segments, "engine": engine, "span": round(span, 2),
            "language": language or "auto"}
