"""Scenarios: for now, a poem on disk that can be opened again.

The rest of the pipeline — the narration, the scenes, the storyboards — was
taken out to be rebuilt one step at a time. What stays is the part every later
step will stand on: a record with an id, a name, the text, and the step it has
reached.
"""
from __future__ import annotations

import json
import re
import shutil
import time
from pathlib import Path
from typing import Any, Optional

from .config import DATA_DIR

SCEN_DIR = DATA_DIR / "scenarios"


def _now() -> int:
    return int(time.time())


def _folder(scen_id: str) -> Path:
    return SCEN_DIR / Path(scen_id).name


def lines_of(text: str) -> list[str]:
    """The poem as lines, blank ones kept — they are where the stanzas break."""
    return [l.rstrip() for l in (text or "").replace("\r\n", "\n").split("\n")]


def title_from(text: str) -> str:
    """A name for the list, taken from the first line that has words in it."""
    for line in lines_of(text):
        words = re.sub(r"[^\w\s'-]", "", line, flags=re.UNICODE).split()
        if words:
            return " ".join(words[:6])[:60]
    return "Untitled"


def listing() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if not SCEN_DIR.is_dir():
        return out
    for folder in sorted(p for p in SCEN_DIR.iterdir() if p.is_dir()):
        meta = folder / "scenario.json"
        if not meta.exists():
            continue
        try:
            rec = json.loads(meta.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        out.append({
            "id": rec.get("id"), "name": rec.get("name") or "Untitled",
            "mode": rec.get("mode", "poem"), "step": rec.get("step", "poem"),
            "created_at": rec.get("created_at", 0), "updated_at": rec.get("updated_at", 0),
        })
    return sorted(out, key=lambda s: -(s.get("updated_at") or 0))


def create(mode: str = "poem", name: str = "") -> dict[str, Any]:
    scen_id = f"s{int(time.time() * 1000):x}"
    rec = {"id": scen_id, "name": name or "Untitled", "mode": mode, "step": "poem",
           "created_at": _now(), "updated_at": _now(), "poem": {"text": ""}}
    return write(rec)


def read(scen_id: str) -> Optional[dict[str, Any]]:
    meta = _folder(scen_id) / "scenario.json"
    if not meta.exists():
        return None
    try:
        return json.loads(meta.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def write(rec: dict[str, Any]) -> dict[str, Any]:
    folder = _folder(rec["id"])
    folder.mkdir(parents=True, exist_ok=True)
    rec["updated_at"] = _now()
    (folder / "scenario.json").write_text(json.dumps(rec, ensure_ascii=False, indent=1),
                                          encoding="utf-8")
    return rec


def patch(scen_id: str, fields: dict[str, Any]) -> Optional[dict[str, Any]]:
    """Change some of a scenario and keep the rest — including where it stopped."""
    rec = read(scen_id)
    if not rec:
        return None
    rec.update(fields)
    return write(rec)


def remove(scen_id: str) -> bool:
    folder = _folder(scen_id).resolve()
    if SCEN_DIR.resolve() not in folder.parents or not folder.is_dir():
        return False
    shutil.rmtree(folder, ignore_errors=True)
    return True
