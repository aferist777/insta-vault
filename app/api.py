"""FastAPI backend.

The server is stateless on purpose: it downloads media, prepares derived files and
serves them. Everything that is "data" — the archive index, settings, layout,
editor projects — lives in the browser's localStorage.

The only durable copy on disk is `media/<shortcode>/meta.json`, which lets the
client rebuild its whole index with Rescan if localStorage is ever cleared.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import uuid
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import (assets, beautify, characters, faces, fonts, generate, looks,
               portrait, providers, render, scenarios, scenes, speech, transcribe)
from .config import ASSETS_DIR, MEDIA_DIR, RENDERS_DIR, WEB_DIR
from .downloader import DownloadError, download_post, parse_shortcode

app = FastAPI(title="Insta Vault")

# Set by main.py so file dialogs can be attached to the native window.
WINDOW: Any = None

# --------------------------------------------------------------------------- #
# download jobs
# --------------------------------------------------------------------------- #

_jobs: dict[str, dict[str, Any]] = {}
_jobs_lock = threading.Lock()

# A task gets a progress callback and returns (record, final stage text).
Task = Any


def _new_job(labels: list[str]) -> str:
    job_id = uuid.uuid4().hex[:12]
    _jobs[job_id] = {
        "id": job_id,
        "started_at": time.time(),
        "done": False,
        "current": 0,
        "items": [{"url": l, "status": "pending", "stage": "Queued", "pct": None} for l in labels],
    }
    return job_id


def _run_tasks(job_id: str, tasks: list[Task]) -> None:
    """Run tasks one by one, mirroring their progress into the job."""
    job = _jobs[job_id]
    for i, task in enumerate(tasks):
        item = job["items"][i]

        def progress(stage: str, pct: Optional[float] = None, _item=item) -> None:
            with _jobs_lock:
                _item["stage"] = stage
                _item["pct"] = pct

        with _jobs_lock:
            job["current"] = i
            item.update(status="working", stage="Starting")

        try:
            record, stage, extra = task(progress)
            with _jobs_lock:
                if record is None and stage:          # skipped
                    item.update(status="skipped", stage=stage, **extra)
                else:
                    item.update(status="done", stage=stage, pct=1.0, record=record, **extra)
        except Exception as exc:  # noqa: BLE001
            with _jobs_lock:
                item.update(status="error", stage=str(exc), pct=None)
    with _jobs_lock:
        job.update(done=True, finished_at=time.time())


def _start(labels: list[str], tasks: list[Task]) -> dict[str, Any]:
    job_id = _new_job(labels)
    threading.Thread(target=_run_tasks, args=(job_id, tasks), daemon=True).start()
    return {"job_id": job_id, "count": len(tasks)}


class SaveRequest(BaseModel):
    urls: list[str]
    skip_existing: bool = True
    known: list[str] = []
    # settings live in localStorage, so the client passes them along per job
    cookies_browser: str = ""
    ig_username: str = ""


@app.post("/api/save")
def save(req: SaveRequest) -> dict[str, Any]:
    urls = [u.strip() for u in req.urls if u.strip()]
    if not urls:
        raise HTTPException(400, "No links provided")
    known = set(req.known)
    opts = {"cookies_browser": req.cookies_browser, "ig_username": req.ig_username}

    def make_task(url: str):
        def task(progress):
            shortcode = parse_shortcode(url)
            if req.skip_existing and shortcode and shortcode in known:
                return None, "Already in archive", {"shortcode": shortcode}
            rec = download_post(url, progress, opts)
            return rec, f"Saved · {rec['media_count']} file(s)", {"shortcode": rec["shortcode"]}
        return task

    return _start(urls, [make_task(u) for u in urls])


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str) -> dict[str, Any]:
    job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "Unknown job")
    with _jobs_lock:
        return {**job, "items": [dict(i) for i in job["items"]], "elapsed": time.time() - job["started_at"]}


# --------------------------------------------------------------------------- #
# media on disk
# --------------------------------------------------------------------------- #

@app.get("/api/rescan")
def rescan() -> dict[str, Any]:
    """Rebuild the archive index from meta.json files sitting next to the media."""
    records: list[dict[str, Any]] = []
    broken: list[str] = []
    for folder in sorted(p for p in MEDIA_DIR.iterdir() if p.is_dir()):
        meta = folder / "meta.json"
        if not meta.exists():
            broken.append(folder.name)
            continue
        try:
            rec = json.loads(meta.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            broken.append(folder.name)
            continue
        rec["media"] = [m for m in rec.get("media", []) if (folder / m["filename"]).exists()]
        if not rec["media"]:
            broken.append(folder.name)
            continue
        rec["media_count"] = len(rec["media"])
        rec["folder"] = folder.name
        if rec.get("thumb") and not (MEDIA_DIR / rec["thumb"]).exists():
            rec["thumb"] = None
        records.append(rec)
    return {"records": records, "broken": broken}


@app.get("/api/media/{shortcode}/uses")
def media_uses(shortcode: str) -> dict[str, Any]:
    """What would go with this post — asked before anything is deleted."""
    return {"assets": assets.derived_from(shortcode)}


@app.delete("/api/media/{shortcode}")
def delete_media(shortcode: str) -> dict[str, Any]:
    """Erase a post completely: its media folder and every asset built from it.
    Renders are the one thing that survives — they are finished work, not source."""
    folder = (MEDIA_DIR / shortcode).resolve()
    if MEDIA_DIR.resolve() not in folder.parents:
        raise HTTPException(400, "Bad shortcode")
    gone = [a for a in assets.derived_from(shortcode) if assets.delete(a)]
    if folder.is_dir():
        shutil.rmtree(folder, ignore_errors=True)
    return {"ok": True, "assets": gone}


# --------------------------------------------------------------------------- #
# assets (editor)
# --------------------------------------------------------------------------- #

class ImportRequest(BaseModel):
    paths: list[str]


class FromVaultRequest(BaseModel):
    shortcode: str
    filename: str
    mode: str = "media"      # media | audio
    name: str = ""


@app.get("/api/assets")
def list_assets() -> dict[str, Any]:
    """The library, with the litter taken out first.

    Records whose file has gone are dropped here rather than waiting for someone
    to press a button: every list the app asks for is already clean, so nothing
    downstream has to reason about assets that cannot be played or rendered.
    """
    swept = assets.sweep()
    return {"assets": assets.scan(), "swept": swept}


@app.get("/api/assets/pick")
def pick_files() -> dict[str, Any]:
    """Native file dialog — returns real paths, so big files are never uploaded."""
    if WINDOW is None:
        raise HTTPException(400, "File picker needs the app window (running headless)")
    import webview

    types = ("Media files (*.mp4;*.mov;*.mkv;*.webm;*.jpg;*.jpeg;*.png;*.webp;"
             "*.mp3;*.m4a;*.wav;*.aac;*.ogg;*.flac)", "All files (*.*)")
    chosen = WINDOW.create_file_dialog(webview.OPEN_DIALOG, allow_multiple=True, file_types=types)
    return {"paths": list(chosen or [])}


@app.post("/api/assets/import")
def import_assets(req: ImportRequest) -> dict[str, Any]:
    paths = [Path(p) for p in req.paths if p.strip()]
    if not paths:
        raise HTTPException(400, "No files given")

    def make_task(path: Path):
        def task(progress):
            asset = assets.import_local(path, progress)
            return asset, f"Imported · {asset['kind']}", {"asset_id": asset["id"]}
        return task

    return _start([p.name for p in paths], [make_task(p) for p in paths])


@app.post("/api/assets/from-vault")
def asset_from_vault(req: FromVaultRequest) -> dict[str, Any]:
    def task(progress):
        asset = assets.from_vault(req.shortcode, req.filename, req.mode, req.name, progress)
        label = "Audio extracted" if req.mode == "audio" else f"Added · {asset['kind']}"
        return asset, label, {"asset_id": asset["id"]}

    label = f"{req.shortcode}/{req.filename}" + (" → audio" if req.mode == "audio" else "")
    return _start([label], [task])


class ExtractRequest(BaseModel):
    asset_id: str
    start: float = 0.0
    end: float = 0.0
    name: str = ""


@app.post("/api/assets/extract-audio")
def extract_audio_range(req: ExtractRequest) -> dict[str, Any]:
    def task(progress):
        asset = assets.extract_range(req.asset_id, req.start, req.end, req.name, progress)
        return asset, f"Audio saved · {asset['name']}", {"asset_id": asset["id"]}

    return _start([f"Extract audio · {req.name or req.asset_id}"], [task])


@app.delete("/api/assets/{asset_id}")
def delete_asset(asset_id: str) -> dict[str, bool]:
    return {"ok": assets.delete(asset_id)}


# --------------------------------------------------------------------------- #
# render
# --------------------------------------------------------------------------- #

class RenderRequest(BaseModel):
    project: dict[str, Any]


@app.post("/api/render")
def render_project(req: RenderRequest) -> dict[str, Any]:
    name = req.project.get("name") or "project"

    def task(progress):
        result = render.render(req.project, progress)
        note = f"{result['file']} · {result['size'] / 1e6:.1f} MB"
        return result, note, {}

    return _start([f"Render · {name}"], [task])


@app.get("/api/renders")
def list_renders() -> dict[str, Any]:
    files = sorted(RENDERS_DIR.glob("*.mp4"), key=lambda p: p.stat().st_mtime, reverse=True)
    return {"renders": [
        {"file": f.name, "size": f.stat().st_size, "at": int(f.stat().st_mtime)} for f in files[:50]
    ]}


def _open_in_explorer(path: Path) -> None:
    if sys.platform == "win32":
        os.startfile(path)  # noqa: S606
    elif sys.platform == "darwin":
        subprocess.Popen(["open", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path)])


@app.post("/api/reveal")
def reveal(body: dict[str, Any]) -> dict[str, bool]:
    target = MEDIA_DIR
    if body.get("renders"):
        _open_in_explorer(RENDERS_DIR)
        return {"ok": True}
    asset_id = body.get("asset")
    if asset_id:
        folder = (ASSETS_DIR / str(asset_id)).resolve()
        if ASSETS_DIR.resolve() not in folder.parents or not folder.is_dir():
            raise HTTPException(404, "Asset folder is gone")
        _open_in_explorer(folder)
        return {"ok": True}
    shortcode = body.get("shortcode")
    if shortcode:
        folder = (MEDIA_DIR / shortcode).resolve()
        if MEDIA_DIR.resolve() not in folder.parents or not folder.is_dir():
            raise HTTPException(404, "Folder is gone")
        target = folder
    _open_in_explorer(target)
    return {"ok": True}


# --------------------------------------------------------------------------- #
# providers & speech
# --------------------------------------------------------------------------- #

class KeyTest(BaseModel):
    provider: str
    key: str


@app.post("/api/keys/test")
def test_key(req: KeyTest) -> dict[str, Any]:
    """Check a key with its provider. The key is used and forgotten."""
    return providers.test_key(req.provider, req.key)


class SceneRequest(BaseModel):
    asset_id: str
    start: float = 0.0            # in-point in source seconds
    end: float = 0.0              # out-point in source seconds


@app.post("/api/scenes")
def find_scenes(req: SceneRequest) -> dict[str, Any]:
    def task(progress):
        result = scenes.detect(req.asset_id, req.start, req.end, progress)
        return result, f"{len(result['cuts'])} candidate cut(s)", {}

    return _start([f"Scan · {req.asset_id}"], [task])


# --------------------------------------------------------------------------- #
# fonts
# --------------------------------------------------------------------------- #

@app.get("/api/fonts")
def list_fonts(rescan: bool = False) -> dict[str, Any]:
    """The cached registry; `rescan=1` reads every font file again."""
    return fonts.scan(force=rescan)


@app.get("/api/fonts/pick")
def pick_fonts() -> dict[str, Any]:
    if WINDOW is None:
        raise HTTPException(400, "File picker needs the app window (running headless)")
    import webview

    chosen = WINDOW.create_file_dialog(
        webview.OPEN_DIALOG, allow_multiple=True,
        file_types=("Font files (*.ttf;*.otf;*.ttc)", "All files (*.*)"))
    return {"paths": list(chosen or [])}


@app.post("/api/fonts/add")
def add_fonts(req: ImportRequest) -> dict[str, Any]:
    return fonts.add_files(req.paths)


class GenerateRequest(BaseModel):
    key: str
    asset_id: str
    start: float
    length: float
    seconds: int
    quality: str = "480p"
    prompt: str
    face_id: str = ""
    label: str = "AI"
    model: str = ""
    orientation: str = "video"
    background: str = "input_video"


@app.get("/api/ai/models")
def ai_models() -> dict[str, Any]:
    """What the tool can send work to, and which settings each one offers."""
    return {"models": {k: {kk: vv for kk, vv in v.items() if kk != "id"}
                       for k, v in generate.MODELS.items()},
            "default": generate.DEFAULT_MODEL}


@app.post("/api/ai/generate")
def ai_generate(req: GenerateRequest) -> dict[str, Any]:
    """Send one fragment through seedance and bring back an asset."""
    asset = assets.health(_asset_record(req.asset_id))
    src = assets.source_of(asset)
    if not src or not src.exists():
        raise HTTPException(400, "That clip's file is missing")
    face = faces.file_of(req.face_id) if req.face_id else None

    def task(progress):
        made = generate.run(req.key.strip(), src, req.start, req.length, req.seconds,
                            req.quality, req.prompt, face, req.label, progress,
                            req.model or generate.DEFAULT_MODEL, req.orientation,
                            req.background)
        return made, "Ready", {"asset_id": made["id"]}

    return _start([req.label], [task])


def _asset_record(asset_id: str) -> dict[str, Any]:
    meta = ASSETS_DIR / asset_id / "asset.json"
    if not meta.exists():
        raise HTTPException(404, "No such asset")
    return json.loads(meta.read_text(encoding="utf-8"))


class BeautifyRequest(BaseModel):
    key: str
    tool: str
    facts: dict[str, Any] = {}
    refs: list[dict[str, str]] = []


@app.post("/api/prompt/beautify")
def beautify_prompt(req: BeautifyRequest) -> dict[str, Any]:
    """Settings in, one paragraph of prompt out."""
    if not req.key.strip():
        raise HTTPException(400, "No kie.ai key — add one in Preferences")
    try:
        return beautify.compose(req.key.strip(), req.tool, req.facts, req.refs)
    except urllib.error.HTTPError as e:
        raise HTTPException(502, f"kie.ai said {e.code}") from e
    except (urllib.error.URLError, ValueError, TimeoutError) as e:
        raise HTTPException(502, f"Could not write the prompt: {e}") from e


# ---------------------------------------------------------------- faces ----

class StageRequest(BaseModel):
    path: str = ""


class SaveFaceRequest(BaseModel):
    token: str
    x: int = 0
    y: int = 0
    size: int = 0
    source: str = "uploaded"
    name: str = ""


def _with_bodies(data: dict[str, Any]) -> dict[str, Any]:
    """Both framings of the same candidate, so the bench can switch modes freely.

    The still on the bench is one picture; whether the user is after a face or a
    whole character only decides which rectangle is drawn over it. Working both
    out here costs one extra pass over an image already in memory and saves a
    round trip every time the spine is pressed.
    """
    still = faces.STAGING / f"{Path(data.get('token', '')).name}.jpg"
    data["bodies"] = characters.portraits(still) if still.exists() else []
    return data


@app.get("/api/faces")
def list_faces() -> dict[str, Any]:
    return {"faces": faces.listing()}


@app.post("/api/faces/stage")
def stage_face(req: StageRequest) -> dict[str, Any]:
    """Put a picture from disk on the bench and detect the faces in it.

    A video goes through the job queue instead of answering straight away: a
    small copy has to be made first, and that takes long enough to be worth a
    progress bar rather than a spinning dot.
    """
    src = Path(req.path)
    if not src.is_file():
        raise HTTPException(400, "No such file")
    if src.suffix.lower() in faces.VIDEO_SUFFIXES:
        def task(progress):
            data = faces.stage_file(src, progress)
            return data, "Ready to look through", data
        return _start([src.name], [task])
    try:
        return _with_bodies(faces.stage_file(src))
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


class StageMediaRequest(BaseModel):
    shortcode: str
    filename: str
    at: float = 0.0


@app.post("/api/faces/stage-media")
def stage_from_archive(req: StageMediaRequest) -> dict[str, Any]:
    """A frame of a saved post, put on the bench — for grabbing a face while browsing."""
    src = (MEDIA_DIR / req.shortcode / Path(req.filename).name).resolve()
    if MEDIA_DIR.resolve() not in src.parents or not src.is_file():
        raise HTTPException(404, "No such file in the archive")
    try:
        return _with_bodies(faces.stage_still(src, req.at))
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@app.post("/api/faces/random")
def random_face() -> dict[str, Any]:
    try:
        return _with_bodies(faces.stage_random())
    except Exception as e:                       # network, or a page instead of a jpeg
        raise HTTPException(502, f"Could not fetch a face: {e}") from e


class FrameRequest(BaseModel):
    token: str
    at: float = 0.0
    look: bool = True


@app.post("/api/faces/frame")
def face_frame(req: FrameRequest) -> dict[str, Any]:
    """One frame out of the staged video — with a look for faces when asked."""
    try:
        return _with_bodies(faces.grab_frame(req.token, req.at, req.look))
    except (FileNotFoundError, ValueError) as e:
        raise HTTPException(400, str(e)) from e


@app.get("/api/faces/staged/{token}")
def staged_face(token: str, t: float = 0.0, proxy: bool = False):
    from fastapi.responses import FileResponse

    p = faces.staged_path(token, proxy)
    if not p:
        raise HTTPException(404, "Nothing on the bench")
    return FileResponse(p, headers={"Cache-Control": "no-store"})


@app.post("/api/faces/save")
def save_face(req: SaveFaceRequest) -> dict[str, Any]:
    try:
        return faces.save(req.token, {"x": req.x, "y": req.y, "size": req.size},
                          req.source, req.name or None)
    except (FileNotFoundError, ValueError) as e:
        raise HTTPException(400, str(e)) from e


@app.get("/api/faces/file/{face_id}")
def face_file(face_id: str, thumb: bool = False):
    from fastapi.responses import FileResponse

    p = faces.file_of(face_id, thumb)
    if not p:
        raise HTTPException(404, "No such face")
    return FileResponse(p)


@app.patch("/api/faces/{face_id}")
def rename_face(face_id: str, req: StageRequest) -> dict[str, Any]:
    if not faces.rename(face_id, req.path):
        raise HTTPException(400, "Could not rename")
    return {"ok": True}


@app.delete("/api/faces/{face_id}")
def delete_face(face_id: str) -> dict[str, Any]:
    return {"ok": faces.remove(face_id)}


@app.get("/api/characters")
def list_characters() -> dict[str, Any]:
    return {"characters": characters.listing()}


@app.post("/api/characters/save")
def save_character(req: SaveFaceRequest) -> dict[str, Any]:
    """Keep the portrait currently framed on the bench.

    The bench, the staging and the detector are the face library's; only the
    shape of the crop and the shelf it lands on are different.
    """
    try:
        return characters.save(req.token, {"x": req.x, "y": req.y, "size": req.size},
                               req.source, req.name or None)
    except (FileNotFoundError, ValueError) as e:
        raise HTTPException(400, str(e)) from e


@app.get("/api/characters/file/{char_id}")
def character_file(char_id: str, thumb: bool = False):
    from fastapi.responses import FileResponse

    p = characters.file_of(char_id, thumb)
    if not p:
        raise HTTPException(404, "No such character")
    return FileResponse(p)


@app.patch("/api/characters/{char_id}")
def rename_character(char_id: str, req: StageRequest) -> dict[str, Any]:
    if not characters.rename(char_id, req.path):
        raise HTTPException(400, "Could not rename")
    return {"ok": True}


@app.delete("/api/characters/{char_id}")
def delete_character(char_id: str) -> dict[str, Any]:
    return {"ok": characters.remove(char_id)}


# --------------------------------------------------------------------------- #
# scenarios: a poem, a narrator, a shot list
# --------------------------------------------------------------------------- #

class ScenarioNew(BaseModel):
    mode: str = "poem"
    name: str = ""


class ScenarioPatch(BaseModel):
    fields: dict[str, Any] = {}


@app.get("/api/scenarios")
def list_scenarios() -> dict[str, Any]:
    return {"scenarios": scenarios.listing()}


@app.post("/api/scenarios")
def new_scenario(req: ScenarioNew) -> dict[str, Any]:
    return scenarios.create(req.mode, req.name)


@app.get("/api/scenarios/{scen_id}")
def get_scenario(scen_id: str) -> dict[str, Any]:
    rec = scenarios.read(scen_id)
    if not rec:
        raise HTTPException(404, "No such scenario")
    return rec


@app.patch("/api/scenarios/{scen_id}")
def patch_scenario(scen_id: str, req: ScenarioPatch) -> dict[str, Any]:
    rec = scenarios.patch(scen_id, req.fields)
    if not rec:
        raise HTTPException(404, "No such scenario")
    return rec


@app.delete("/api/scenarios/{scen_id}")
def delete_scenario(scen_id: str) -> dict[str, Any]:
    return {"ok": scenarios.remove(scen_id)}


class CharacterUpload(BaseModel):
    path: str = ""              # a file picked from disk
    imgbb: str = ""             # where the models will fetch it from


class CharacterRead(BaseModel):
    key: str = ""


class CharacterDraw(BaseModel):
    key: str = ""
    imgbb: str = ""
    model: str = looks.DEFAULT_MODEL
    params: dict[str, Any] = {}


@app.get("/api/looks")
def list_looks() -> dict[str, Any]:
    """The styles a character can be redrawn in, and what can do the redrawing."""
    return {"styles": looks.STYLES,
            "models": {k: {"label": v["label"], "fields": v["fields"]}
                       for k, v in looks.IMAGE_MODELS.items()},
            "default_style": looks.DEFAULT_STYLE, "default_model": looks.DEFAULT_MODEL}


@app.post("/api/scenarios/{scen_id}/character")
def put_character(scen_id: str, req: CharacterUpload) -> dict[str, Any]:
    """Take a picture of the character in, and put it where the models can see it.

    The upload happens once, here, because both the reading and the drawing need
    a URL — and doing it twice would be two copies of the same picture on someone
    else's server.
    """
    rec = scenarios.read(scen_id)
    if not rec:
        raise HTTPException(404, "No such scenario")
    src = Path(req.path)
    if not src.is_file():
        raise HTTPException(400, "No such file")
    dst = scenarios.SCEN_DIR / scen_id / f"character{src.suffix.lower() or '.jpg'}"
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, dst)
    try:
        url = generate.host(dst, req.imgbb.strip())
    except Exception as e:  # noqa: BLE001 — the host is the only thing that can fail here
        raise HTTPException(502, f"Could not put the picture online: {e}") from e
    char = {**(rec.get("character") or {}), "file": dst.name, "url": url,
            "description": "", "result": "", "result_url": ""}
    rec["character"] = char
    return scenarios.write(rec)


@app.post("/api/scenarios/{scen_id}/character/read")
def read_character(scen_id: str, req: CharacterRead) -> dict[str, Any]:
    """Describe the person in the uploaded picture, and nothing around them."""
    rec = scenarios.read(scen_id)
    if not rec:
        raise HTTPException(404, "No such scenario")
    char = rec.get("character") or {}
    here = scenarios.SCEN_DIR / Path(scen_id).name / Path(char.get("file") or "x").name
    if not here.exists():
        raise HTTPException(400, "There is no picture to read")
    if not req.key.strip():
        raise HTTPException(400, "No kie.ai key — add one in Preferences")

    def task(progress):
        progress("Reading the character", 0.3)
        # straight off disk: reading needs no upload host, and the hosts are the
        # least reliable part of this whole chain
        said = portrait.read_character(req.key.strip(), portrait.as_data_uri(here))
        fresh = scenarios.read(scen_id) or rec
        fresh["character"] = {**(fresh.get("character") or {}), "description": said}
        scenarios.write(fresh)
        return fresh, f"{len(said.split())} words", {}

    return _start(["reading the character"], [task])


@app.post("/api/scenarios/{scen_id}/character/draw")
def draw_character(scen_id: str, req: CharacterDraw) -> dict[str, Any]:
    """Redraw the character in the chosen style, full length on white."""
    rec = scenarios.read(scen_id)
    if not rec:
        raise HTTPException(404, "No such scenario")
    char = rec.get("character") or {}
    if not char.get("url"):
        raise HTTPException(400, "There is no picture to work from")
    if not (char.get("description") or "").strip():
        raise HTTPException(400, "Read the character first — the description is what is drawn")
    if not req.key.strip():
        raise HTTPException(400, "No kie.ai key — add one in Preferences")
    style_id = rec.get("style_id") or looks.DEFAULT_STYLE

    def task(progress):
        prompt = portrait.draw_prompt(char["description"], style_id)
        # every attempt is kept: the cheap one was the one you threw away, and
        # there is no way to know that until later
        room = scenarios.SCEN_DIR / scen_id / "drawn"
        room.mkdir(parents=True, exist_ok=True)
        dst = room / f"{style_id}-{req.model}-{int(time.time())}.png"
        portrait.redraw(req.key.strip(), req.model, prompt, char["url"],
                        req.params or {}, dst, progress)
        progress("Putting it where it can be reused", 0.9)
        try:
            url = generate.host(dst, req.imgbb.strip())
        except Exception:  # noqa: BLE001 — a local copy is still a result
            url = ""
        fresh = scenarios.read(scen_id) or rec
        fresh["character"] = {**(fresh.get("character") or {}),
                              "result": f"drawn/{dst.name}", "result_url": url,
                              "drawn_style": style_id, "drawn_model": req.model,
                              "prompt": prompt}
        fresh["step"] = "character"
        scenarios.write(fresh)
        return fresh, "character drawn", {}

    return _start([f"character · {looks.IMAGE_MODELS.get(req.model, {}).get('label', req.model)}"],
                  [task])


@app.get("/api/scenarios/{scen_id}/character/{which}")
def character_file(scen_id: str, which: str):
    """The uploaded picture, or the redrawn one, straight off disk."""
    from fastapi.responses import FileResponse

    rec = scenarios.read(scen_id) or {}
    char = rec.get("character") or {}
    name = char.get("result") if which == "result" else char.get("file")
    if not name:
        raise HTTPException(404, "Nothing there yet")
    room = scenarios.SCEN_DIR / Path(scen_id).name
    p = (room / name).resolve()
    if room.resolve() not in p.parents or not p.exists():
        raise HTTPException(404, "Nothing there yet")
    return FileResponse(p, headers={"Cache-Control": "no-store"})


@app.get("/api/scenarios/{scen_id}/drawn")
def list_drawn(scen_id: str) -> dict[str, Any]:
    """Everything ever drawn for this character, newest first."""
    room = scenarios.SCEN_DIR / Path(scen_id).name / "drawn"
    if not room.is_dir():
        return {"drawn": []}
    files = sorted(room.glob("*.png"), key=lambda f: -f.stat().st_mtime)
    rec = scenarios.read(scen_id) or {}
    using = ((rec.get("character") or {}).get("result") or "").split("/")[-1]
    return {"drawn": [{"file": f"drawn/{f.name}", "name": f.name,
                       "at": int(f.stat().st_mtime), "in_use": f.name == using}
                      for f in files]}


@app.post("/api/scenarios/{scen_id}/reveal")
def reveal_scenario(scen_id: str) -> dict[str, bool]:
    """Open the folder where every draw for this scenario is kept."""
    room = (scenarios.SCEN_DIR / Path(scen_id).name / "drawn").resolve()
    if scenarios.SCEN_DIR.resolve() not in room.parents:
        raise HTTPException(400, "Bad scenario")
    room.mkdir(parents=True, exist_ok=True)
    _open_in_explorer(room)
    return {"ok": True}


@app.get("/api/fonts/file/{family}")
def font_file(family: str, style: str = ""):
    """The actual file, so a font the system doesn't have can still be shown."""
    from fastapi.responses import FileResponse

    path = fonts.file_for(family, "bold" in style, "italic" in style)
    if not path or not Path(path).exists():
        raise HTTPException(404, "No such font")
    return FileResponse(path)


class TranscribeRequest(BaseModel):
    asset_id: str
    start: float = 0.0
    end: float = 0.0
    engine: str = "groq"          # groq | local
    key: str = ""                 # travels with the job, never stored
    model: str = "small"
    device: str = "auto"
    language: str = ""


@app.post("/api/transcribe")
def transcribe_clip(req: TranscribeRequest) -> dict[str, Any]:
    def task(progress):
        result = transcribe.run(req.asset_id, req.start, req.end, req.model_dump(), progress)
        return result, f"{len(result['segments'])} phrase(s)", {}

    return _start([f"Transcribe · {req.asset_id}"], [task])


class SilenceRequest(BaseModel):
    asset_id: str
    start: float = 0.0
    end: float = 0.0
    noise_db: float = -30.0
    min_len: float = 0.5


@app.post("/api/silence")
def find_silence(req: SilenceRequest) -> dict[str, Any]:
    def task(progress):
        result = scenes.detect_silence(req.asset_id, req.start, req.end,
                                       req.noise_db, req.min_len, progress)
        return result, f"{len(result['gaps'])} quiet stretch(es)", {}

    return _start([f"Silence · {req.asset_id}"], [task])


@app.get("/api/speech/status")
def speech_status() -> dict[str, Any]:
    return speech.status()


@app.post("/api/speech/install")
def speech_install() -> dict[str, Any]:
    def task(progress):
        result = speech.install(progress)
        note = ("already installed" if result.get("already")
                else "installed — restart the app to use it" if result.get("restart_needed")
                else "installed")
        return result, f"faster-whisper {note}", {}

    return _start(["Install faster-whisper"], [task])


@app.get("/api/paths")
def paths() -> dict[str, str]:
    return {
        "media_dir": str(MEDIA_DIR),
        "assets_dir": str(ASSETS_DIR),
        "renders_dir": str(RENDERS_DIR),
        "sep": os.sep,
    }


# --------------------------------------------------------------------------- #
# static
# --------------------------------------------------------------------------- #

@app.middleware("http")
async def no_cache(request, call_next):
    response = await call_next(request)
    if request.url.path.endswith((".html", ".css", ".js")) or request.url.path == "/":
        response.headers["Cache-Control"] = "no-store"
    return response


@app.exception_handler(DownloadError)
async def download_error_handler(request, exc: DownloadError):
    return JSONResponse({"detail": str(exc)}, status_code=400)


app.mount("/media", StaticFiles(directory=MEDIA_DIR), name="media")
app.mount("/assets", StaticFiles(directory=ASSETS_DIR), name="assets")
app.mount("/renders", StaticFiles(directory=RENDERS_DIR), name="renders")
app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
