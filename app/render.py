"""Turn an editor project into an mp4 with one ffmpeg pass.

The project comes from the browser (it lives in localStorage), the asset paths
are resolved here from `assets/<id>/asset.json`. Everything the preview shows —
trim, speed, cover fit, position, colour, opacity, blend, volume and fades — is
translated into a single filter_complex so the render matches what you saw.
"""
from __future__ import annotations

import json
import math
import re
import time
from pathlib import Path
from typing import Any, Optional

from . import media_tools as mt
from .config import ASSETS_DIR, DATA_DIR, MEDIA_DIR, RENDERS_DIR

# canvas blend name -> ffmpeg blend name
BLEND_MAP = {
    "multiply": "multiply", "screen": "screen", "overlay": "overlay",
    "darken": "darken", "lighten": "lighten",
    "color-dodge": "dodge", "color-burn": "burn",
    "hard-light": "hardlight", "soft-light": "softlight",
    "difference": "difference", "exclusion": "exclusion",
}
# ffmpeg has no separable equivalent for these, they fall back to normal
UNSUPPORTED_BLEND = {"hue", "saturation", "color", "luminosity"}

# How much bigger than the canvas an animated frame is prepared, to keep
# zoompan's whole-pixel rounding well below one output pixel. Costs memory and
# encoding time, so only clips with animated framing go through it. Measured on
# a 6s push: at 1x the edge stutters backwards and jumps 2px at a time, at 2x
# twice, at 3x never — so 3x it is, capped so a wide zoom range can't blow the
# intermediate frame up past ZOOM_MAX_SIDE.
ZOOM_OVERSAMPLE = 3.0
ZOOM_MAX_SIDE = 8000

# the colour that leaves the layer below untouched for a given blend
NEUTRAL = {
    "screen": "black", "lighten": "black", "difference": "black", "exclusion": "black",
    "multiply": "white", "darken": "white",
    "overlay": "gray", "hardlight": "gray", "softlight": "gray",
    "dodge": "black", "burn": "white",
}


class RenderError(Exception):
    pass


def active_asset_id(clip: dict[str, Any]) -> Optional[str]:
    """Which file this clip is currently playing: the original, or the AI variant
    the user switched to. The same rule runs in web/app.js — a clip that shows an
    AI version in the preview has to render as that version."""
    chosen = clip.get("variant")
    if chosen:
        for v in clip.get("variants") or []:
            if v.get("id") == chosen:
                return v.get("asset_id")
    return clip.get("asset_id")


def _asset(asset_id: str) -> Optional[dict[str, Any]]:
    meta = ASSETS_DIR / str(asset_id) / "asset.json"
    if not meta.exists():
        return None
    try:
        return json.loads(meta.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def _source(asset: dict[str, Any]) -> Optional[Path]:
    if asset.get("src"):
        return ASSETS_DIR / asset["src"]
    if asset.get("media_url"):
        return MEDIA_DIR / asset["media_url"]
    return None


def _num(v: Any, default: float) -> float:
    try:
        f = float(v)
        return f if f == f else default          # NaN guard
    except (TypeError, ValueError):
        return default


def clip_len(clip: dict[str, Any]) -> float:
    speed = _num(clip.get("params", {}).get("speed"), 1.0) or 1.0
    return (_num(clip.get("out"), 0) - _num(clip.get("in"), 0)) / speed


HL_GROW = 1.12                     # the same enlargement the preview uses

# how a line arrives: how far it travels in ems, along which axis, on which curve
ENTRANCES = {
    "fade":  (0.0, 0.0, "out"),
    "up":    (0.0, 1.2, "out"),
    "down":  (0.0, -1.2, "out"),
    "left":  (-1.6, 0.0, "out"),
    "right": (1.6, 0.0, "out"),
    "drop":  (0.0, -2.2, "bounce"),
    "swing": (-2.2, 0.0, "back"),
}
ENTER_OUT = 0.15


def _entrance(p: dict[str, Any], size: int, start: float, end: float):
    """(dx, dy, alpha) as ffmpeg expressions, or None when the line just appears.

    Only x, y and alpha take expressions in drawtext, so those are the three
    things an arrival is allowed to move — the preset list on the other side is
    built from the same limit, and the two therefore cannot drift apart.
    """
    spec = ENTRANCES.get(p.get("enter") or "none")
    if not spec:
        return None
    dx_em, dy_em, ease = spec
    length = max(0.05, _num(p.get("enter_len"), 0.3))
    u = f"clip((t-{start:.3f})/{length:.3f},0,1)"
    e = _ease_expr(u, ease)
    rest = f"(1-{e})"
    out = f"clip(({end:.3f}-t)/{ENTER_OUT},0,1)"
    return (f"({dx_em * size:.2f}*{rest})" if dx_em else "0",
            f"({dy_em * size:.2f}*{rest})" if dy_em else "0",
            f"min({u},{out})")


def _words(graph: list[str], acc: str, layout: list[dict[str, Any]], p: dict[str, Any],
           font: Path, text_dir: Path, n: int, size: int, alpha: str, edge: str,
           start: float, end: float) -> str:
    """A line laid out word by word, so one word can be picked out as it is said.

    Every x and every baseline comes from the browser: it measured the words with
    the same font file, and ffmpeg lays a line out about 2.5% narrower than the
    canvas does (measured), so anything computed here would drift away from what
    the user arranged on screen. `y=<baseline>-ascent` is what puts the words on
    one line — drawtext's own y is the top of the ink, which moves with the
    glyphs, and words would sit at different heights without it.
    """
    mode = p.get("hl_mode") or "color"
    hl_color = p.get("hl_color") or "#ffe066"
    base_color = p.get("color", "#ffffff")
    pad_x, pad_y = size * 0.4, size * 0.22
    window = f"enable='between(t,{start:.3f},{end:.3f})'"
    # the plate is a box, not part of a drawtext, so its width can match
    # the canvas exactly; the price is that it holds its opacity through a
    # transition while the words themselves fade
    plate_alpha = clamp01(_num(p.get("box_opacity"), 0.45))
    # the arrival moves every word of the line together, and dims them together
    ent = _entrance(p, size, start, end)
    dx = f"+{ent[0]}" if ent and ent[0] != "0" else ""
    dy = f"+{ent[1]}" if ent and ent[1] != "0" else ""
    if ent:
        alpha = f"({alpha})*({ent[2]})"

    for li, line in enumerate(layout):
        left, base = _num(line.get("left"), 0), _num(line.get("baseline"), 0)
        if p.get("box"):
            graph.append(
                f"[{acc}]drawbox=x='{left - pad_x:.2f}{dx}':y='{base - size * 0.72 - pad_y:.2f}{dy}'"
                f":w={_num(line.get('width'), 0) + pad_x * 2:.2f}:h={size + pad_y * 2:.2f}"
                f":color={p.get('box_color', '#000000')}@{plate_alpha:.2f}:t=fill"
                f":{window}[b{n}_{li}]")
            acc = f"b{n}_{li}"

        for wi, word in enumerate(line.get("words") or []):
            text = str(word.get("text") or "")
            if not text.strip():
                continue
            tf = text_dir / f"w{n}_{li}_{wi}.txt"
            tf.write_text(text, encoding="utf-8")
            x = left + _num(word.get("off"), 0)
            width = _num(word.get("width"), 0)
            t0, t1 = word.get("t0"), word.get("t1")
            lit = (t0 is not None and t1 is not None
                   and min(end, float(t1)) > max(start, float(t0)))
            if lit:
                t0, t1 = max(start, float(t0)), min(end, float(t1))
            common = (f"drawtext=fontfile='{_ff_path(font)}':textfile='{_ff_path(tf)}'"
                      f":y='{base:.2f}{dy}-ascent'{edge}")

            # the plain word: hidden while it is being said, unless the highlight
            # is only a plate behind it
            hide = lit and mode != "plate"
            a = f"({alpha})*(1-between(t,{t0:.3f},{t1:.3f}))" if hide else alpha
            graph.append(f"[{acc}]{common}:fontsize={size}:fontcolor={base_color}"
                         f":x='{x:.2f}{dx}':alpha='{a}':{window}[w{n}_{li}_{wi}]")
            acc = f"w{n}_{li}_{wi}"
            if not lit:
                continue

            lit_window = f"enable='between(t,{t0:.3f},{t1:.3f})'"
            if mode == "plate":
                graph.append(
                    f"[{acc}]drawbox=x='{x - pad_x * 0.4:.2f}{dx}':y='{base - size * 0.72 - pad_y * 0.6:.2f}{dy}'"
                    f":w={width + pad_x * 0.8:.2f}:h={size + pad_y * 1.2:.2f}"
                    f":color={hl_color}@1:t=fill:{lit_window}[p{n}_{li}_{wi}]")
                acc = f"p{n}_{li}_{wi}"
                # the word again on top of its plate, so the plate never covers it
                graph.append(f"[{acc}]{common}:fontsize={size}:fontcolor={base_color}"
                             f":x='{x:.2f}{dx}':alpha='{alpha}':{lit_window}[h{n}_{li}_{wi}]")
            else:
                grown = mode == "grow"
                fs = int(round(size * HL_GROW)) if grown else size
                gx = x - width * (HL_GROW - 1) / 2 if grown else x
                graph.append(f"[{acc}]{common}:fontsize={fs}:fontcolor={hl_color}"
                             f":x='{gx:.2f}{dx}':alpha='{alpha}':{lit_window}[h{n}_{li}_{wi}]")
            acc = f"h{n}_{li}_{wi}"
    return acc


def project_duration(project: dict[str, Any]) -> float:
    end = 0.0
    for track in project.get("tracks", []):
        for clip in track.get("clips", []):
            end = max(end, _num(clip.get("start"), 0) + clip_len(clip))
    return end


def _even(n: float) -> int:
    return max(2, int(round(n / 2)) * 2)


# --------------------------------------------------------------------------- #
# keyframes -> ffmpeg expressions
# --------------------------------------------------------------------------- #

# Easing curves. Mirrors EASINGS in web/app.js — the preview and the render must
# agree, so any curve added there has to grow an expression here as well.
_BOUNCE_N, _BOUNCE_D = 7.5625, 2.75


def _ease(u: float, mode: str) -> float:
    if mode == "smooth":
        return u * u * (3 - 2 * u)
    if mode == "in":
        return u * u
    if mode == "out":
        return u * (2 - u)
    if mode == "inout":
        return 4 * u ** 3 if u < 0.5 else 1 - (-2 * u + 2) ** 3 / 2
    if mode == "back":
        return 1 + 2.70158 * (u - 1) ** 3 + 1.70158 * (u - 1) ** 2
    if mode == "elastic":
        if u <= 0 or u >= 1:
            return max(0.0, min(1.0, u))
        return 2 ** (-10 * u) * math.sin((10 * u - 0.75) * 2.0943951) + 1
    if mode == "bounce":
        n, d = _BOUNCE_N, _BOUNCE_D
        if u < 1 / d:
            return n * u * u
        if u < 2 / d:
            x = u - 1.5 / d
            return n * x * x + 0.75
        if u < 2.5 / d:
            x = u - 2.25 / d
            return n * x * x + 0.9375
        x = u - 2.625 / d
        return n * x * x + 0.984375
    return u


def _ease_expr(u: str, mode: str) -> str:
    """The same curve as an ffmpeg expression, `u` being the 0..1 progress term."""
    if mode == "smooth":
        return f"({u}*{u}*(3-2*{u}))"
    if mode == "in":
        return f"({u}*{u})"
    if mode == "out":
        return f"({u}*(2-{u}))"
    if mode == "inout":
        return f"(if(lt({u},0.5),4*{u}*{u}*{u},1-pow(2-2*{u},3)/2))"
    if mode == "back":
        return f"(1+2.70158*pow({u}-1,3)+1.70158*pow({u}-1,2))"
    if mode == "elastic":
        return f"(pow(2,-10*{u})*sin((10*{u}-0.75)*2.0943951)+1)"
    if mode == "bounce":
        n, d = _BOUNCE_N, _BOUNCE_D
        seg3 = f"({n}*pow({u}-{2.625 / d:.5f},2)+0.984375)"
        seg2 = f"if(lt({u},{2.5 / d:.5f}),{n}*pow({u}-{2.25 / d:.5f},2)+0.9375,{seg3})"
        seg1 = f"if(lt({u},{2 / d:.5f}),{n}*pow({u}-{1.5 / d:.5f},2)+0.75,{seg2})"
        return f"(if(lt({u},{1 / d:.5f}),{n}*{u}*{u},{seg1}))"
    return u


def keys_of(clip: dict[str, Any], key: str) -> list[dict[str, Any]]:
    kfs = (clip.get("keyframes") or {}).get(key) or []
    return sorted((k for k in kfs if "t" in k and "v" in k), key=lambda k: _num(k.get("t"), 0))


def animated(clip: dict[str, Any], key: str) -> bool:
    return len(keys_of(clip, key)) > 0


def value_at(clip: dict[str, Any], key: str, t_rel: float, default: float) -> float:
    """Same maths as the preview, used when a single number is enough."""
    kfs = keys_of(clip, key)
    if not kfs:
        return _num((clip.get("params") or {}).get(key), default)
    if len(kfs) == 1 or t_rel <= _num(kfs[0]["t"], 0):
        return _num(kfs[0]["v"], default)
    if t_rel >= _num(kfs[-1]["t"], 0):
        return _num(kfs[-1]["v"], default)
    for a, b in zip(kfs, kfs[1:]):
        ta, tb = _num(a["t"], 0), _num(b["t"], 0)
        if ta <= t_rel <= tb:
            u = _ease((t_rel - ta) / (tb - ta or 1e-6), b.get("ease") or a.get("ease") or "linear")
            return _num(a["v"], default) + (_num(b["v"], default) - _num(a["v"], default)) * u
    return _num(kfs[-1]["v"], default)


def expr_for(clip: dict[str, Any], key: str, default: float,
             scale: float = 1.0, offset: float = 0.0, var: str = "t") -> str:
    """A piecewise-linear ffmpeg expression in clip-local seconds.

    `var` is the filter's own time variable — filters disagree: eq and volume
    take `t`, geq wants `T`, and zoompan only knows its frame counter `on`.
    `scale`/`offset` map the stored value onto what the filter expects.
    """
    kfs = keys_of(clip, key)
    if not kfs:
        return f"{_num((clip.get('params') or {}).get(key), default) * scale + offset:.5f}"

    def out(v: float) -> str:
        return f"{v * scale + offset:.5f}"

    first_t = _num(kfs[0]["t"], 0)
    expr = out(_num(kfs[-1]["v"], default))                 # value after the last keyframe
    for a, b in reversed(list(zip(kfs, kfs[1:]))):
        ta, tb = _num(a["t"], 0), _num(b["t"], 0)
        va, vb = _num(a["v"], default), _num(b["v"], default)
        span = max(tb - ta, 1e-6)
        u = f"((({var})-{ta:.4f})/{span:.4f})"
        u = _ease_expr(u, b.get("ease") or a.get("ease") or "linear")
        seg = f"({out(va)}+({out(vb)}-{out(va)})*{u})"
        expr = f"if(lt({var},{tb:.4f}),{seg},{expr})"
    return f"if(lt({var},{first_t:.4f}),{out(_num(kfs[0]['v'], default))},{expr})"


def _atempo(speed: float) -> list[str]:
    """atempo only takes 0.5–2.0, so bigger changes are chained."""
    out: list[str] = []
    left = speed
    while left > 2.0:
        out.append("atempo=2.0")
        left /= 2.0
    while left < 0.5:
        out.append("atempo=0.5")
        left /= 0.5
    if abs(left - 1.0) > 1e-3:
        out.append(f"atempo={left:.6f}")
    return out


def build(project: dict[str, Any]) -> tuple[list[str], float, list[str]]:
    """Return (ffmpeg args without the binary, total duration, notes)."""
    canvas = project.get("canvas") or {}
    W, H = int(canvas.get("w", 1080)), int(canvas.get("h", 1920))
    FPS = int(canvas.get("fps", 30))
    total = project_duration(project)
    if total <= 0:
        raise RenderError("Nothing on the timeline")

    tracks = project.get("tracks", [])
    video_tracks = [t for t in tracks if t.get("kind") == "video"]
    audio_tracks = [t for t in tracks if t.get("kind") == "audio"]
    any_solo = any(t.get("solo") for t in audio_tracks)

    inputs: list[str] = []
    graph: list[str] = [f"color=c=black:s={W}x{H}:r={FPS}:d={total:.3f}[base]"]
    notes: list[str] = []
    acc = "base"
    idx = 0

    # ---- video: bottom track first, higher tracks paint over it ----
    for track in video_tracks:
        if track.get("hidden"):
            continue
        for clip in sorted(track.get("clips", []), key=lambda c: _num(c.get("start"), 0)):
            asset = _asset(active_asset_id(clip))
            src = _source(asset) if asset else None
            if not src or not src.exists():
                notes.append(f"skipped “{clip.get('name', clip.get('id'))}” — source file missing")
                continue

            p = clip.get("params") or {}
            speed = _num(p.get("speed"), 1.0) or 1.0
            start = _num(clip.get("start"), 0)
            src_in = _num(clip.get("in"), 0)
            src_dur = max(0.05, _num(clip.get("out"), 0) - src_in)
            tl_dur = src_dur / speed
            end = start + tl_dur

            is_still = asset.get("kind") == "image"
            if is_still:
                inputs += ["-loop", "1", "-t", f"{tl_dur:.3f}", "-i", str(src)]
            else:
                inputs += ["-ss", f"{src_in:.3f}", "-t", f"{src_dur:.3f}", "-i", str(src)]

            nat_w = int(asset.get("width") or W)
            nat_h = int(asset.get("height") or H)
            # fit, not fill: the whole source frame stays visible, matching the preview
            base_cover = min(W / nat_w, H / nat_h)

            # every expression inside this chain runs in clip-local time: the
            # shift onto the timeline is the last step
            frame_anim = any(animated(clip, k) for k in ("scale", "x", "y"))
            zooms = [_num(k["v"], 1) for k in keys_of(clip, "scale")] or [_num(p.get("scale"), 1.0)]
            z_max = max(0.05, max(zooms))
            z_min = max(0.05, min(zooms))
            # zoompan's z=1 means "the whole padded frame", so the padding has to
            # stand for the widest view the clip ever shows. A clip that never
            # zooms out below 1 (a static Zoom of 1.05 with an animated drift, say)
            # needs no padding at all — using z_min there asked pad to be smaller
            # than its own input and ffmpeg refused the whole graph.
            #
            # zoompan also refuses to pan outside its own frame: at zoom 1 there is
            # nowhere to go, so a slide-out simply didn't move. Every unit of shift
            # needs two units of headroom, which is bought by treating the frame as
            # if it were zoomed out that much further.
            pans = [abs(_num(kf["v"], 0)) for key in ("x", "y") for kf in keys_of(clip, key)]
            pans += [abs(_num(p.get("x"), 0)), abs(_num(p.get("y"), 0))]
            z_ref = min(z_min, 1.0) / (1 + 2 * max(pans + [0.0]))
            # …but never pad the intermediate frame past what memory can take
            z_ref = max(z_ref, max(W, H) * z_max / ZOOM_MAX_SIDE)
            still_scale = _num(p.get("scale"), 1.0)

            if frame_anim:
                # zoompan is the only filter that animates framing while keeping
                # the output size fixed; it can't zoom below 1, so the source is
                # padded and the whole range is shifted up to start at 1.
                # It also rounds its x/y to whole pixels, which on a slow move
                # makes the picture sit still and then jump — measured as 2px
                # steps and a stutter backwards. Feeding it an oversized frame
                # makes each rounding step a fraction of an output pixel.
                over = max(1.0, min(ZOOM_OVERSAMPLE,
                                    ZOOM_MAX_SIDE / max(W, H) / max(1e-6, z_max / z_ref)))
                w = _even(nat_w * base_cover * z_max * over)
                h = _even(nat_h * base_cover * z_max * over)
            else:
                w = _even(nat_w * base_cover * still_scale)
                h = _even(nat_h * base_cover * still_scale)
            x = int((W - w) / 2 + _num(p.get("x"), 0) * W)
            y = int((H - h) / 2 + _num(p.get("y"), 0) * H)

            chain = [f"[{idx}:v]scale={w}:{h}", "setsar=1", f"fps={FPS}"]
            if not is_still and abs(speed - 1.0) > 1e-3:
                chain.append(f"setpts=PTS/{speed:.6f}")
            if _num(p.get("rotate"), 0):
                chain.append(f"rotate={_num(p.get('rotate'), 0)}*PI/180:c=none")

            if frame_anim:
                pad_w = _even(W * z_max / z_ref * over)
                pad_h = _even(H * z_max / z_ref * over)
                chain.append(f"crop={_even(min(w, W * z_max * over))}"
                             f":{_even(min(h, H * z_max * over))}")
                # the padding must be *transparent*: black bars would hide the
                # tracks underneath and, worse, brightness would lift them out of
                # black into visible grey. The preview draws only the picture, so
                # this is also what makes the two agree.
                chain.append("format=rgba")
                chain.append(f"pad={pad_w}:{pad_h}:(ow-iw)/2:(oh-ih)/2:color=black@0")
                clock = f"(on/{FPS})"
                z_e = expr_for(clip, "scale", 1.0, scale=1 / z_ref, var=clock)
                x_e = expr_for(clip, "x", 0.0, var=clock)
                y_e = expr_for(clip, "y", 0.0, var=clock)
                chain.append(
                    f"zoompan=z='max(1,{z_e})'"
                    f":x='(iw-iw/zoom)/2-({x_e})*iw/zoom'"
                    f":y='(ih-ih/zoom)/2-({y_e})*ih/zoom'"
                    f":d=1:s={W}x{H}:fps={FPS}"
                )
                x = y = 0

            colour_anim = any(animated(clip, k) for k in ("brightness", "contrast", "saturation"))
            bri = _num(p.get("brightness"), 0)
            con = _num(p.get("contrast"), 1)
            sat = _num(p.get("saturation"), 1)
            if colour_anim:
                chain.append(
                    f"eq=eval=frame:brightness='{expr_for(clip, 'brightness', 0.0)}'"
                    f":contrast='{expr_for(clip, 'contrast', 1.0)}'"
                    f":saturation='{expr_for(clip, 'saturation', 1.0)}'"
                )
            elif abs(bri) > 1e-3 or abs(con - 1) > 1e-3 or abs(sat - 1) > 1e-3:
                chain.append(f"eq=brightness={bri:.3f}:contrast={con:.3f}:saturation={sat:.3f}")

            trans = transition_expr(clip, tl_dur, W, H)
            if animated(clip, "opacity") or trans:
                # alpha is computed per pixel here; geq spells time with a capital T
                a_e = expr_for(clip, "opacity", 1.0, var="T")
                factor = f"clip({a_e},0,1)" + (f"*({trans})" if trans else "")
                chain += ["format=rgba",
                          f"geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*{factor}'"]
            else:
                opacity = clamp01(_num(p.get("opacity"), 1))
                if opacity < 0.999:
                    chain += ["format=rgba", f"colorchannelmixer=aa={opacity:.3f}"]

            chain.append(f"setpts=PTS+{start:.3f}/TB")
            graph.append(",".join(chain) + f"[v{idx}]")

            blend_name = (p.get("blend") or "normal")
            if blend_name in UNSUPPORTED_BLEND:
                notes.append(f"“{blend_name}” blend has no ffmpeg equivalent — rendered as normal")
                blend_name = "normal"
            mode = BLEND_MAP.get(blend_name)

            if not mode:
                graph.append(
                    f"[{acc}][v{idx}]overlay=x={x}:y={y}:eof_action=repeat:"
                    f"enable='between(t,{start:.3f},{end:.3f})'[c{idx}]"
                )
            else:
                # blend works on whole frames, so the clip is padded outside its
                # window with the colour that leaves the layers below untouched
                neutral = NEUTRAL.get(mode, "black")
                graph.append(f"color=c={neutral}:s={W}x{H}:r={FPS}:d={total:.3f}[n{idx}]")
                graph.append(
                    f"[n{idx}][v{idx}]overlay=x={x}:y={y}:eof_action=repeat:"
                    f"enable='between(t,{start:.3f},{end:.3f})'[p{idx}]"
                )
                graph.append(f"[{acc}][p{idx}]blend=all_mode={mode}[c{idx}]")
            acc = f"c{idx}"
            idx += 1

    # ---- titles, drawn on top of every picture layer ----
    text_clips = [
        (t, c) for t in tracks if t.get("kind") == "text" and not t.get("hidden")
        for c in sorted(t.get("clips", []), key=lambda c: _num(c.get("start"), 0))
        if str(c.get("text") or "").strip()
    ]
    if text_clips:
        font = _font_file()
        if not font:
            notes.append("no usable font found — titles were skipped")
        else:
            missing_fonts: set[str] = set()
            text_dir = DATA_DIR / "text"          # scratch files, not part of the output
            text_dir.mkdir(parents=True, exist_ok=True)
            for n, (track, clip) in enumerate(text_clips):
                p = {**{"size": 84, "color": "#ffffff", "align": "center", "y": 0.5,
                        "box": True, "box_color": "#000000", "box_opacity": 0.45},
                     **(clip.get("params") or {})}
                start = _num(clip.get("start"), 0)
                dur = max(0.1, _num(clip.get("out"), 0) - _num(clip.get("in"), 0))
                end = start + dur
                # the text travels in a file: no escaping games with quotes or colons
                words = str(clip.get("text") or "")
                if p.get("case") == "upper":
                    words = words.upper()
                # one drawtext per line: a single multi-line drawtext centres the
                # block and left-aligns the lines inside it, while the preview
                # centres each line — this is what keeps the two identical
                text_lines = words.split("\n") or [""]
                size = int(_num(p.get("size"), 84))
                align = p.get("align", "center")
                # the clip may ask for a specific family; fall back loudly, not silently
                clip_font = font
                wanted = (p.get("font") or "").strip()
                if wanted:
                    from . import fonts as font_registry
                    found = font_registry.file_for(wanted, bool(p.get("bold")),
                                                   bool(p.get("italic")))
                    if found:
                        clip_font = found
                    else:
                        missing_fonts.add(wanted)
                x_e = {"left": f"{int(W * 0.08)}", "right": f"w-text_w-{int(W * 0.08)}"}.get(
                    align, "(w-text_w)/2")
                # the same nudge the preview applies when a subtitle is dragged
                nudge = _num(p.get("x"), 0) * W
                if abs(nudge) > 0.5:
                    x_e = f"{x_e}{nudge:+.1f}"
                trans = transition_expr(clip, dur, W, H, var=f"(t-{start:.3f})")
                opacity = clamp01(_num(p.get("opacity"), 1))
                alpha = f"{opacity:.3f}" + (f"*({trans})" if trans else "")
                box = ""
                if p.get("box"):
                    box = (f":box=1:boxcolor={p.get('box_color', '#000000')}"
                           f"@{clamp01(_num(p.get('box_opacity'), 0.45)):.2f}"
                           f":boxborderw={max(4, int(size * 0.22))}")   # matches the canvas padding
                # outline and shadow: the same two things the canvas draws
                edge = ""
                if _num(p.get("outline"), 0) > 0:
                    edge += (f":borderw={int(_num(p.get('outline'), 0))}"
                             f":bordercolor={p.get('outline_color', '#000000')}")
                if p.get("shadow"):
                    off = max(1, int(round(_num(p.get("shadow_dist"), 3))))
                    edge += (f":shadowx={off}:shadowy={off}"
                             f":shadowcolor={p.get('shadow_color', '#000000')}")
                # same geometry as the canvas: lines 1.25em apart, the block centred
                # on the chosen height
                line_h = size * 1.25
                top = _num(p.get("y"), 0.5) * H - (len(text_lines) - 1) * line_h / 2
                ent = _entrance(p, size, start, end)
                if ent:
                    if ent[0] != "0":
                        x_e = f"{x_e}+{ent[0]}"
                    alpha = f"({alpha})*({ent[2]})"
                shift_y = f"+{ent[1]}" if ent and ent[1] != "0" else ""

                # a line that picks out the spoken word is drawn word by word, at
                # the positions the browser measured — see _words()
                layout = clip.get("layout") if p.get("hl") else None
                if layout:
                    acc = _words(graph, acc, layout, p, clip_font, text_dir, n,
                                 size, alpha, edge, start, end)
                    continue
                for li, line in enumerate(text_lines):
                    tf = text_dir / f"t{n}_{li}.txt"
                    tf.write_text(line, encoding="utf-8")
                    y_line = top + li * line_h
                    label = f"x{n}_{li}"
                    graph.append(
                        f"[{acc}]drawtext=fontfile='{_ff_path(clip_font)}':textfile='{_ff_path(tf)}'"
                        f":fontsize={size}:fontcolor={p.get('color', '#ffffff')}"
                        f":x='{x_e}':y='{y_line:.2f}{shift_y}-text_h/2'"
                        f":alpha='{alpha}':enable='between(t,{start:.3f},{end:.3f})'{box}{edge}[{label}]"
                    )
                    acc = label

            if missing_fonts:
                notes.append("font(s) not on this machine, drawn with the default: "
                             + ", ".join(sorted(missing_fonts)))

    # ---- audio ----
    audio_labels: list[str] = []
    for track in audio_tracks:
        if track.get("muted") or (any_solo and not track.get("solo")):
            continue
        for clip in sorted(track.get("clips", []), key=lambda c: _num(c.get("start"), 0)):
            asset = _asset(active_asset_id(clip))
            src = _source(asset) if asset else None
            if not src or not src.exists() or asset.get("kind") == "image":
                continue
            if not asset.get("has_audio", True):
                continue

            p = clip.get("params") or {}
            speed = _num(p.get("speed"), 1.0) or 1.0
            start = _num(clip.get("start"), 0)
            src_in = _num(clip.get("in"), 0)
            src_dur = max(0.05, _num(clip.get("out"), 0) - src_in)
            tl_dur = src_dur / speed

            inputs += ["-ss", f"{src_in:.3f}", "-t", f"{src_dur:.3f}", "-i", str(src)]
            chain = [f"[{idx}:a]aresample=48000"]
            chain += _atempo(speed)
            if animated(clip, "volume"):
                # the delay comes later, so the expression is written in clip time
                chain.append(f"volume=eval=frame:volume='{expr_for(clip, 'volume', 1.0)}'")
            else:
                vol = max(0.0, _num(p.get("volume"), 1))
                if abs(vol - 1) > 1e-3:
                    chain.append(f"volume={vol:.4f}")
            fi = _num(p.get("fade_in"), 0)
            fo = _num(p.get("fade_out"), 0)
            if fi > 0.01:
                chain.append(f"afade=t=in:st=0:d={min(fi, tl_dur):.3f}")
            if fo > 0.01:
                chain.append(f"afade=t=out:st={max(0, tl_dur - fo):.3f}:d={min(fo, tl_dur):.3f}")
            if start > 0.001:
                ms = int(start * 1000)
                chain.append(f"adelay={ms}|{ms}")
            graph.append(",".join(chain) + f"[a{idx}]")
            audio_labels.append(f"[a{idx}]")
            idx += 1

    if idx == 0 and not text_clips:
        raise RenderError("No usable clips — every source file is missing")

    out_args = ["-map", f"[{acc}]"]
    if audio_labels:
        graph.append(
            "".join(audio_labels) + f"amix=inputs={len(audio_labels)}:duration=longest:normalize=0[aout]"
        )
        out_args += ["-map", "[aout]", "-c:a", "aac", "-b:a", "192k"]
    else:
        out_args += ["-an"]

    args = [*inputs, "-filter_complex", ";\n".join(graph), *out_args,
            "-t", f"{total:.3f}", "-r", str(FPS),
            "-c:v", "libx264", "-preset", "medium", "-crf", "20",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart"]
    return args, total, notes


def clamp01(v: float) -> float:
    return max(0.0, min(1.0, v))


FONT_CANDIDATES = [
    r"C:\Windows\Fonts\segoeuib.ttf", r"C:\Windows\Fonts\arialbd.ttf",
    r"C:\Windows\Fonts\segoeui.ttf", r"C:\Windows\Fonts\arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
]


def _font_file() -> Optional[str]:
    for f in FONT_CANDIDATES:
        if Path(f).exists():
            return f
    return None


def _ff_path(p: Path | str) -> str:
    """Windows paths inside a filtergraph need forward slashes and an escaped colon."""
    return str(p).replace("\\", "/").replace(":", "\\:")


def transition_expr(clip: dict[str, Any], tl_dur: float, W: int, H: int, var: str = "T") -> str:
    """Alpha factor for the clip's in/out transitions, in geq terms (time is `T`).

    A dissolve is a plain ramp; a wipe is a hard edge that travels across the
    frame. Both multiply the clip's own alpha, so a clip fading in over another
    one reads as a cross-dissolve.
    """
    parts: list[str] = []
    for key, edge in (("transition_in", "in"), ("transition_out", "out")):
        spec = clip.get(key) or {}
        kind = spec.get("type")
        dur = _num(spec.get("dur"), 0.5)
        if not kind or kind == "none" or dur <= 0.01:
            continue
        # progress 0 -> 1 across the transition
        prog = (f"clip({var}/{dur:.4f},0,1)" if edge == "in"
                else f"clip(({tl_dur:.4f}-{var})/{dur:.4f},0,1)")
        if kind == "dissolve":
            parts.append(prog)
        elif kind == "wipe-left":
            parts.append(f"if(lt(X,{W}*{prog}),1,0)")
        elif kind == "wipe-right":
            parts.append(f"if(gt(X,{W}*(1-{prog})),1,0)")
        elif kind == "wipe-up":
            parts.append(f"if(lt(Y,{H}*{prog}),1,0)")
        elif kind == "wipe-down":
            parts.append(f"if(gt(Y,{H}*(1-{prog})),1,0)")
    return "*".join(parts)


def _safe_name(name: str) -> str:
    cleaned = re.sub(r"[^\w\-. ]+", "", name or "project").strip().replace(" ", "-")
    return cleaned[:40] or "project"


def render(project: dict[str, Any], progress: mt.ProgressCb) -> dict[str, Any]:
    args, total, notes = build(project)
    RENDERS_DIR.mkdir(parents=True, exist_ok=True)
    out = RENDERS_DIR / f"{_safe_name(project.get('name'))}-{time.strftime('%Y%m%d-%H%M%S')}.mp4"

    # keyframe expressions carry commas and quotes and can get long, so the graph
    # travels in a file instead of on the command line
    graph_file = RENDERS_DIR / (out.stem + ".filters.txt")
    at = args.index("-filter_complex")
    graph_file.write_text(args[at + 1], encoding="utf-8")
    args = [*args[:at], "-filter_complex_script", str(graph_file), *args[at + 2:]]

    progress("Building the timeline", 0.0)
    try:
        mt.run_ffmpeg([*args, str(out)], total, progress, "Rendering")
    except Exception as exc:
        # a failed graph is the only evidence of what went wrong, so it stays on
        # disk; the half-written mp4 is useless and only clutters the folder
        if out.exists() and out.stat().st_size == 0:
            out.unlink(missing_ok=True)
        raise RenderError(f"{exc}\n\nfilter graph kept at {graph_file}") from exc
    graph_file.unlink(missing_ok=True)
    if not out.exists():
        raise RenderError("ffmpeg produced no file")
    return {
        "file": out.name,
        "path": str(out),
        "size": out.stat().st_size,
        "duration": round(total, 2),
        "notes": notes,
    }
