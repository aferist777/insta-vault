"""Sending a fragment to seedance and bringing the result home.

The shape of the work, in order: cut the chosen seconds out of the source, put
them and the reference face somewhere the model can reach, ask for the video,
wait, download it, cut it back to the exact length and give it the original
sound. What comes back is an ordinary asset in the library, attached to the clip
as a variant — the timeline keeps its original either way.

Every number here was measured against the live API; see docs/kie-seedance.md.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable, Optional

from . import assets, media_tools as mt
from .config import DATA_DIR

BASE = "https://api.kie.ai"
WORK = DATA_DIR / "ai"

# The picture editor that prepares the anchor frame: a face swapped on one still
# costs two cents and five seconds, against a video generation's twenty-seven.
FRAME_MODEL = "nano-banana-2-lite"

# What the tool can send the work to. Each entry says what the model is called,
# what it charges, and which of its settings the panel offers — they have almost
# nothing in common, which is exactly why the panel has to be told.
MODELS = {
    "seedance": {
        "id": "bytedance/seedance-2-mini",
        "label": "Seedance 2.0 Mini",
        "wants_frame": False,
        "qualities": {"480p": 6.0, "720p": 12.5},      # credits per second
        "duration": (4, 15),                            # whole seconds, asked for
    },
    "kling_mc": {
        "id": "kling-3.0/motion-control",
        "label": "Kling 3.0 Motion Control",
        # built for exactly this errand: it takes the movement from a video and
        # the person from a picture, and is meant to hold the face while doing it
        "wants_frame": True,
        "qualities": {"720p": 12.0, "1080p": 21.0},     # per second of the reference video
        "duration": None,                               # follows the fragment
        "clip_seconds": (3, 30),
        "backgrounds": ["input_video", "input_image"],
    },
}
DEFAULT_MODEL = "kling_mc"

MIN_S, MAX_S = 4, 15            # whole seconds the model accepts
POLL = 8                        # seconds between asking whether it is done
DEADLINE = 20 * 60              # a run took ~4.5 min in testing; this is the ceiling
# "480p" names the short side, the way every player and every service means it.
# Scaling by the long side left a portrait clip at its full 720x1280 — bigger
# than the quality that was paid for, and a heavier upload for nothing.
SHORT_SIDE = {"480p": 480, "720p": 720, "1080p": 1080}

Progress = Callable[..., None]

LOG = WORK / "run.log"


def note(line: str) -> None:
    """Leave a trace of the run on disk.

    A generation happens on a worker thread inside a windowed app: when it dies,
    the reason reaches a status line the user has usually already clicked away
    from, and stdout goes to a console nobody is watching. The log is what makes
    a failed run answerable afterwards.
    """
    try:
        WORK.mkdir(parents=True, exist_ok=True)
        with LOG.open("a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%H:%M:%S')}  {line}\n")
    except OSError:
        pass


# --------------------------------------------------------------------------- #
# the public host
# --------------------------------------------------------------------------- #

def _imgbb(path: Path, key: str) -> str:
    import base64
    import urllib.parse
    body = urllib.parse.urlencode({
        "key": key, "image": base64.b64encode(path.read_bytes()).decode(),
    }).encode()
    req = urllib.request.Request("https://api.imgbb.com/1/upload", data=body)
    with urllib.request.urlopen(req, timeout=300) as r:
        answer = json.loads(r.read().decode("utf-8", "replace"))
    return (answer.get("data") or {}).get("url") or ""


def _uguu(path: Path) -> str:
    boundary = f"----ivault{int(time.time() * 1000):x}"
    head = (f'--{boundary}\r\n'
            f'Content-Disposition: form-data; name="files[]"; filename="{path.name}"\r\n'
            'Content-Type: application/octet-stream\r\n\r\n')
    body = head.encode() + path.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request("https://uguu.se/upload?output=text", data=body, headers={
        "Content-Type": f"multipart/form-data; boundary={boundary}",
        "User-Agent": "insta-vault/1.0"})
    with urllib.request.urlopen(req, timeout=300) as r:
        url = r.read().decode("utf-8", "replace").strip()
    return url if url.startswith("http") else ""


def host(path: Path, imgbb_key: str = "") -> str:
    """A public URL for a picture, whichever host is standing today.

    Three of these have gone down on us inside one session — imgbb for
    maintenance, catbox answering 520 to kie's fetcher, 0x0.st closed to uploads
    entirely — so this tries each in turn and says in the log which one it fell
    through to. What matters is not that a host is up for us but that it is
    reachable *from kie*, which is a different question and the reason catbox is
    no longer first.
    """
    ways: list[tuple[str, Any]] = []
    if imgbb_key:
        ways.append(("imgbb", lambda: _imgbb(path, imgbb_key)))
    ways += [("uguu", lambda: _uguu(path)), ("catbox", lambda: upload(path))]

    last = ""
    for name, go in ways:
        try:
            url = go()
            if url:
                if name != ways[0][0]:
                    note(f"hosted on {name} (the ones before it were not available)")
                return url
            last = f"{name} gave no url"
        except Exception as e:  # noqa: BLE001 — any failure means try the next host
            said = ""
            if isinstance(e, urllib.error.HTTPError):
                said = e.read().decode("utf-8", "replace")[:160]
            last = f"{name}: {e} {said}".strip()
            note(f"upload via {last}")
    raise RuntimeError(f"no upload host would take the file — {last}")


def upload(path: Path) -> str:
    """Put a file where kie.ai can fetch it.

    Nothing on this machine is reachable from the outside — the app serves
    localhost — and imgbb takes pictures only, so video goes to catbox, which
    hands back a plain URL and serves it with the right content type (measured).
    """
    boundary = f"----ivault{int(time.time() * 1000):x}"
    mime = "video/mp4" if path.suffix.lower() == ".mp4" else "image/jpeg"
    body = b""
    for name, value in (("reqtype", "fileupload"), ("userhash", "")):
        body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n"
                 f"{value}\r\n").encode()
    body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"fileToUpload\"; "
             f"filename=\"{path.name}\"\r\nContent-Type: {mime}\r\n\r\n").encode()
    body += path.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request("https://catbox.moe/user/api.php", data=body,
                                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=300) as r:
        url = r.read().decode().strip()
    if not url.startswith("http"):
        raise RuntimeError(f"the upload host answered “{url[:80]}”")
    return url


# --------------------------------------------------------------------------- #
# the model
# --------------------------------------------------------------------------- #

def _call(key: str, method: str, path: str, body: Optional[dict] = None,
          params: str = "") -> dict[str, Any]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path + params, data=data, method=method,
                                 headers={"Authorization": f"Bearer {key}",
                                          "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        # kie says what is wrong in the body of the error, not in its status line;
        # letting urllib raise plainly turns "input_urls is required" into "HTTP
        # Error 422", which is no help to anybody
        raw = e.read().decode("utf-8", "replace")
        note(f"HTTP {e.code} from {path}: {raw[:600]}")
        try:
            said = json.loads(raw)
            msg = said.get("msg") or said.get("message") or said.get("error") or raw[:200]
        except json.JSONDecodeError:
            msg = raw[:200] or f"HTTP {e.code}"
        raise RuntimeError(str(msg)) from None


IMAGE_MODEL = "nano-banana-2"          # the fuller one: samples and storyboards are looked at


def draw(key: str, prompt: str, dst: Path, aspect: str = "1:1",
         refs: Optional[list[str]] = None, progress: Optional[Progress] = None) -> Path:
    """A picture from a prompt, kept on disk.

    Style samples and storyboard sheets are both this: one image, square unless
    told otherwise, optionally shown what it should look like. Square is the
    default because a swatch has no reason to have a direction, and a storyboard
    grid divides evenly.
    """
    say = progress or (lambda *a, **k: None)
    payload: dict[str, Any] = {"prompt": prompt, "aspect_ratio": aspect}
    if refs:
        payload["image_urls"] = refs[:10]
    note(f"draw {IMAGE_MODEL} {aspect} refs={len(refs or [])}\n{prompt[:400]}")
    answer = _call(key, "POST", "/api/v1/jobs/createTask",
                   {"model": IMAGE_MODEL, "input": payload})
    task = (answer.get("data") or {}).get("taskId")
    if not task:
        raise RuntimeError(answer.get("msg") or "the picture model would not take the job")
    url = wait(key, task, say, "Drawing")
    return fetch(url, dst)


def make_frame(key: str, scene_url: str, face_url: str, prompt: str, progress: Progress) -> str:
    """Swap the face on one still, and hand back where the result lives.

    This is the cheap half of the job. The video model that follows is then asked
    only to move a picture that already has the right person in it, instead of
    being asked to change who someone is — which it turned out to manage once in
    five tries.
    """
    answer = _call(key, "POST", "/api/v1/jobs/createTask", {"model": FRAME_MODEL, "input": {
        "prompt": prompt, "image_urls": [scene_url, face_url], "aspect_ratio": "auto"}})
    task = (answer.get("data") or {}).get("taskId")
    if not task:
        raise RuntimeError(answer.get("msg") or "the picture editor would not take the job")
    return wait(key, task, progress, "Editing the frame")


def create(key: str, model: str, prompt: str, video_url: str, image_urls: list[str],
           seconds: int, quality: str, orientation: str = "video",
           background: str = "input_video") -> str:
    spec = MODELS[model]
    if model == "kling_mc":
        # one picture, one video, and no duration: the length follows the clip.
        # `mode` is the resolution spelled out: the prose in kie's own doc says
        # std / pro, and the API answers "mode is not within the range of allowed
        # options" to both — it wants 720p / 1080p, the way the doc's own example
        # writes it (measured).
        payload: dict[str, Any] = {
            "prompt": prompt,
            "input_urls": image_urls[:1],
            "video_urls": [video_url],
            "character_orientation": orientation,
            "mode": "1080p" if quality == "1080p" else "720p",
            "background_source": background,
        }
    else:
        payload = {
            "prompt": prompt,
            "reference_video_urls": [video_url],
            "reference_image_urls": image_urls,
            "resolution": quality,
            "aspect_ratio": "adaptive",
            "duration": int(seconds),
            "generate_audio": False,      # the fragment keeps the sound it already has
        }
    # What was asked for, written down **before** it is sent. Saving it only on
    # success is exactly backwards: a request that is accepted needs no
    # explaining, and a refused one leaves nothing at all to look at.
    note(f"createTask {spec['id']}\n" + json.dumps(payload, ensure_ascii=False, indent=1))
    try:
        (WORK / "last_request.json").write_text(
            json.dumps({"model": spec["id"], "input": payload}, ensure_ascii=False, indent=1),
            encoding="utf-8")
    except OSError:
        pass
    answer = _call(key, "POST", "/api/v1/jobs/createTask", {"model": spec["id"], "input": payload})
    task = (answer.get("data") or {}).get("taskId")
    if not task:
        raise RuntimeError(answer.get("msg") or "the model would not take the job")
    note(f"taskId {task}")
    return task


def wait(key: str, task: str, progress: Progress, label: str) -> str:
    """Poll until the task is finished, and hand back the URL of the result."""
    started = time.time()
    while True:
        if time.time() - started > DEADLINE:
            raise TimeoutError("the model did not finish in twenty minutes")
        time.sleep(POLL)
        info = (_call(key, "GET", "/api/v1/jobs/recordInfo", params=f"?taskId={task}")
                .get("data") or {})
        state = info.get("state")
        waited = int(time.time() - started)
        # the wait is long and featureless, so say how long it has been rather
        # than pretend to know how far along it is
        progress(f"{label} · {waited // 60}:{waited % 60:02d}", None)
        if state == "success":
            try:
                urls = json.loads(info.get("resultJson") or "{}").get("resultUrls") or []
            except json.JSONDecodeError:
                urls = []
            if not urls:
                raise RuntimeError("the model reported success with nothing attached")
            return urls[0]
        if state in ("fail", "failed", "error"):
            raise RuntimeError(info.get("failMsg") or "the model gave up on this one")


def fetch(url: str, dst: Path) -> Path:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=600) as r:
        dst.write_bytes(r.read())
    return dst


# --------------------------------------------------------------------------- #
# the pieces of footage
# --------------------------------------------------------------------------- #

def cut(src: Path, start: float, length: float, quality: str, dst: Path) -> Path:
    """The seconds being worked on, at the quality asked for and no larger."""
    side = SHORT_SIDE.get(quality, 480)
    # whichever side is shorter becomes `side`; the other follows the aspect
    scale = (f"scale='if(gt(iw,ih),-2,min({side},iw))':'if(gt(iw,ih),min({side},ih),-2)'"
             ":flags=lanczos")
    mt._run(["-y", "-ss", f"{start:.3f}", "-t", f"{length:.3f}", "-i", str(src),
             "-an", "-vf", scale,
             "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
             "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(dst)])
    if not dst.exists():
        raise RuntimeError("the fragment could not be cut out")
    return dst


def last_frame(src: Path, dst: Path) -> Path:
    """The picture a following part has to continue from."""
    mt._run(["-y", "-sseof", "-0.2", "-i", str(src), "-frames:v", "1", "-q:v", "2", str(dst)])
    return dst


def finish(parts: list[Path], source: Path, start: float, length: float, dst: Path) -> Path:
    """Join the pieces, cut to the exact length, and give it the original sound.

    The model works in whole seconds and knows nothing about the audio, so the
    result is always a little long and always silent. Both are put right here:
    the picture is trimmed to the length that was asked for, and the sound comes
    straight from the source, untouched.
    """
    joined = dst.with_name("joined.mp4")
    if len(parts) == 1:
        joined = parts[0]
    else:
        listing = dst.with_name("parts.txt")
        listing.write_text("".join(f"file '{p.as_posix()}'\n" for p in parts), encoding="utf-8")
        mt._run(["-y", "-f", "concat", "-safe", "0", "-i", str(listing), "-c", "copy", str(joined)])

    has_audio = mt.probe(source).get("has_audio")
    args = ["-y", "-t", f"{length:.3f}", "-i", str(joined)]
    if has_audio:
        args += ["-ss", f"{start:.3f}", "-t", f"{length:.3f}", "-i", str(source),
                 "-map", "0:v:0", "-map", "1:a:0", "-c:a", "aac", "-b:a", "192k", "-shortest"]
    args += ["-c:v", "libx264", "-preset", "medium", "-crf", "20",
             "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(dst)]
    mt._run(args)
    if not dst.exists():
        raise RuntimeError("the finished file could not be assembled")
    return dst


# --------------------------------------------------------------------------- #
# the whole errand
# --------------------------------------------------------------------------- #

FRAME_PROMPT = (
    "Replace the face of the person in the first image with the face from the second image. "
    "Change nothing else: the same hair, the same clothing, the same body, the same background, "
    "the same framing, the same light and the same colour. The picture has no lettering in it — "
    "where the first image shows text, show the scene behind it instead.")


def anchor_frame(key: str, source: Path, start: float, length: float, face: Path,
                 room: Path, progress: Progress) -> tuple[str, float]:
    """A still from the fragment with the new face already on it.

    The frame is chosen by looking for one where a face is actually visible: the
    first frame of a selection often has none, and a reference taken from it
    would show the model nothing to work from.
    """
    from . import faces as face_finder

    progress("Looking for a face in the fragment", 0.05)
    found = face_finder.first_face(source, start, length, room / "scan")
    if not found:
        raise RuntimeError("no face in this fragment — move the selection or pick another clip")
    still = room / "anchor_src.jpg"
    mt._run(["-y", "-ss", f"{found['at']:.3f}", "-i", str(source),
             "-frames:v", "1", "-q:v", "2", str(still)])
    progress("Sending the frame and the face", 0.1)
    scene_url, face_url = upload(still), upload(face)
    url = make_frame(key, scene_url, face_url, FRAME_PROMPT, progress)
    fetch(url, room / "anchor.jpg")               # kept, so it can be looked at afterwards
    return url, found["at"]


def run(key: str, source: Path, start: float, length: float, seconds: int, quality: str,
        prompt: str, face: Optional[Path], label: str, progress: Progress,
        model: str = DEFAULT_MODEL, orientation: str = "video",
        background: str = "input_video") -> dict[str, Any]:
    """One fragment through the model, start to finish, in as many parts as it takes."""
    try:
        return _run(key, source, start, length, seconds, quality, prompt, face, label,
                    progress, model, orientation, background)
    except BaseException as e:
        import traceback
        note(f"FAILED {type(e).__name__}: {e}\n" + traceback.format_exc())
        raise


def _run(key: str, source: Path, start: float, length: float, seconds: int, quality: str,
         prompt: str, face: Optional[Path], label: str, progress: Progress,
         model: str = DEFAULT_MODEL, orientation: str = "video",
         background: str = "input_video") -> dict[str, Any]:
    if not key:
        raise ValueError("no kie.ai key — add one in Preferences")
    if not source.exists():
        raise FileNotFoundError("the clip's file is missing")
    spec = MODELS.get(model) or MODELS[DEFAULT_MODEL]

    WORK.mkdir(parents=True, exist_ok=True)
    stamp = f"{int(time.time() * 1000):x}"
    room = WORK / stamp
    room.mkdir(parents=True, exist_ok=True)
    note(f"--- run {stamp}: {model} {quality} {length:.2f}s from {source.name} "
         f"at {start:.2f}s, facing {orientation}")

    # a fragment longer than the model takes goes in equal pieces
    longest = spec["duration"][1] if spec["duration"] else (spec.get("clip_seconds") or (3, 30))[1]
    count = max(1, int(-(-length // longest)))
    each = length / count
    ask = min(MAX_S, max(MIN_S, int(-(-each // 1))))

    # the model that wants a picture gets one with the face already changed; the
    # one that only wants a face gets the face
    image_url = ""
    if spec["wants_frame"]:
        if not face or not face.exists():
            raise ValueError("this model needs a face to put on the person")
        image_url, _at = anchor_frame(key, source, start, length, face, room, progress)
    elif face and face.exists():
        progress("Sending the face", 0.05)
        image_url = upload(face)

    made: list[Path] = []
    for i in range(count):
        many = f" ({i + 1} of {count})" if count > 1 else ""
        progress(f"Cutting the fragment{many}", 0.15)
        piece = cut(source, start + i * each, each, quality, room / f"in{i}.mp4")
        progress(f"Uploading the fragment{many}", 0.25)
        piece_url = upload(piece)
        note(f"fragment {piece_url} · picture {image_url or '—'}")
        progress(f"Asking the model{many}", 0.3)
        task = create(key, model, prompt, piece_url, [image_url] if image_url else [],
                      ask, quality, orientation, background)
        out_url = wait(key, task, progress, f"Generating{many}")
        progress(f"Downloading the result{many}", 0.9)
        got = fetch(out_url, room / f"out{i}.mp4")
        # what the model made can be a little longer than the piece; the piece rules
        trimmed = room / f"part{i}.mp4"
        mt._run(["-y", "-t", f"{each:.3f}", "-i", str(got), "-c", "copy", str(trimmed)])
        made.append(trimmed if trimmed.exists() else got)

    progress("Putting the sound back", 0.95)
    final = finish(made, source, start, length, room / "final.mp4")
    progress("Adding it to the library", 0.98)
    asset = assets.import_local(final, progress)
    asset["name"] = label
    (Path(assets.ASSETS_DIR) / asset["id"] / "asset.json").write_text(
        json.dumps(asset, ensure_ascii=False, indent=1), encoding="utf-8")
    return asset
