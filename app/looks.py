"""How the cartoon is drawn, and what draws it.

Two tables, and both are here rather than in the client because both end up in a
prompt or a payload on this side of the wire.

**Styles** are described by features, never by the name of a studio. The label in
the interface can say whatever a person recognises; what travels to the model is
the paragraph underneath it. Naming a studio gets jobs refused and is read by the
model however it likes — a list of visual properties is neither.

**Models** differ in what they call the same thing: one has `resolution`, another
`quality`, a third has no notion of quality at all. So each one carries its own
little schema, and the settings popover is drawn from it rather than from a
guess.
"""
from __future__ import annotations

from typing import Any

# --------------------------------------------------------------------------- #
# the look
# --------------------------------------------------------------------------- #

STYLES: list[dict[str, str]] = [
    {"id": "pixar3d", "name": "Pixar 3D",
     "look": "Modern 3D CGI feature animation. Slightly stylised human proportions with a "
             "large cranium and soft rounded jaw; big glossy eyes with a clear catchlight "
             "and visible iris texture; skin rendered with subsurface scattering so ears "
             "and fingers glow faintly against the light; hair built as grouped strands "
             "with soft specular sheen; fabric with woven micro-texture, believable folds "
             "and stitching; warm key light with a cool rim, gentle ambient occlusion in "
             "the creases; saturated but natural palette; shallow depth of field."},
    {"id": "disney", "name": "Classic Disney",
     "look": "Classic feature-animation drawing. Flowing, tapering ink contour of varying "
             "weight; graceful elongated anatomy with a small nose and expressive arched "
             "brows; large almond eyes with soft eyelashes; cel-painted colour in warm "
             "harmonious tones with a hand-painted quality; soft diffused key light and a "
             "gentle bounce; rounded appealing silhouettes; a storybook, romantic mood."},
    {"id": "semireal", "name": "Semi-realistic cartoon",
     "look": "Stylised realism. Correct human proportions and anatomy, with the eyes a "
             "little larger and the expression pushed a little further than life; "
             "believable skin with pores, blush and soft shadow transitions; hair in real "
             "clumps with individual flyaway strands; physically plausible fabric weight "
             "and drape; volumetric light-and-shadow modelling; restrained natural palette; "
             "clean neutral studio lighting."},
    {"id": "lowpoly", "name": "Low-poly 3D",
     "look": "Low-polygon 3D render. Faceted geometry with clearly visible triangles and "
             "hard normals, no smoothing anywhere; simplified blocky hands and features; "
             "flat untextured colour fills with a single flat gradient per surface; sharp "
             "geometric shadows with no softness; small tight palette of six or seven "
             "colours; clean isometric-feeling lighting."},
    {"id": "popart", "name": "Pop-art",
     "look": "1960s comic pop-art print. Heavy uniform black ink outline around every "
             "shape; flat fills in a small set of bright primary colours — red, yellow, "
             "cyan, black; Ben-Day halftone dot screens for shading and skin tone, with "
             "the dots plainly visible; hard graphic shadows; slight off-register printing "
             "and visible newsprint texture; high contrast, no gradients."},
    {"id": "rubberhose", "name": "Rubber hose (1930s)",
     "look": "1930s rubber-hose cartoon. Limbs drawn as bending tubes with no elbows or "
             "knees; round pie-cut eyes and white gloves; bouncy exaggerated poses; even "
             "black line of constant weight; monochrome or sepia range with flat greys; "
             "old film grain, gate weave and a soft vignette; simple stylised shapes."},
    {"id": "soviet", "name": "Soviet classic animation",
     "look": "Traditional hand-made animation of the Soyuzmultfilm school. Soft pencil or "
             "brush contour that varies in weight and sometimes breaks; painterly "
             "watercolour and gouache treatment with visible brush strokes and paper "
             "grain; warm muted palette of ochre, olive, dusty rose and deep blue; gentle "
             "diffused light; kind, slightly melancholic, nostalgic mood."},
    {"id": "ligneclaire", "name": "French / Ligne claire",
     "look": "European ligne claire comics. Thin ink contour of absolutely uniform weight "
             "with no hatching and no line variation; flat areas of restrained pastel "
             "colour with no gradients and almost no shadow; every object equally sharp "
             "and equally lit; clean geometry, careful architectural detail; calm, elegant, "
             "slightly retro atmosphere."},
    {"id": "chibi", "name": "Chibi",
     "look": "Japanese chibi stylisation. Head as tall as the whole body, or half of it; "
             "huge glossy eyes filling much of the face; tiny dot nose and no visible chin; "
             "mitten-simple hands and stubby limbs; soft rounded shapes with a thin even "
             "outline; bright cheerful colour with simple cel shading; exaggerated, "
             "instantly readable emotion."},
    {"id": "kawaii", "name": "Kawaii pastel anime",
     "look": "Soft kawaii anime. Gentle pastel palette of pink, mint, lavender and cream; "
             "large shining eyes with several layered highlights and a gradient iris; thin "
             "delicate contour that lightens in places; soft airbrushed cheek blush; hair "
             "with glossy highlight bands; hazy bloom in the light; sweet, tender mood."},
    {"id": "shonen", "name": "Shonen anime",
     "look": "Action shonen anime. Sharp angular jaw and cheekbones, narrow determined "
             "eyes with strong dark outlines; spiky sharply-parted hair with hard "
             "highlights; bold two-tone cel shading with a crisp shadow edge; strong "
             "contrast and rim light; dynamic pose with clear lines of action; speed lines "
             "and dramatic energy."},
    {"id": "flat2d", "name": "Flat 2D vector",
     "look": "Flat vector television animation. Geometric simplified shapes built from "
             "circles and rectangles; thick even outline, or none at all; completely flat "
             "colour fills with no gradients and no rendered shading; limited bold palette; "
             "simple dot-and-line facial features; silhouettes that read instantly at any "
             "size."},
    {"id": "expressive3d", "name": "Expressive 3D CGI",
     "look": "Expressive 3D CGI feature animation. Caricatured but grounded proportions "
             "with a strong jaw and a knowing, slightly asymmetric grin; heavy expressive "
             "brows; physically based materials with high micro-detail in skin, cloth and "
             "hair; dramatic cinematic key light with strong rim separation; deep contrast "
             "and rich colour grading; confident, theatrical staging."},
]

STYLE_BY_ID = {s["id"]: s for s in STYLES}
DEFAULT_STYLE = STYLES[0]["id"]


# --------------------------------------------------------------------------- #
# what draws it
# --------------------------------------------------------------------------- #
#
# `fields` is what the settings popover shows. `payload` is how this model wants
# to be spoken to — the same square, the same reference, under four different
# field names. Measured against the live API on 2026-08-03.

IMAGE_MODELS: dict[str, dict[str, Any]] = {
    "gpt_image_2": {
        "id": "gpt-image-2-image-to-image",
        "label": "GPT Image 2",
        "fields": [
            {"key": "resolution", "label": "Quality", "kind": "choice",
             # this one is the other way round: "2k" is refused, "2K" is taken
             "options": ["1K", "2K", "4K"], "default": "2K"},
        ],
    },
    "qwen_image_2": {
        "id": "qwen2/image-edit",
        "label": "Qwen Image 2.0",
        "fields": [
            {"key": "output_format", "label": "Format", "kind": "choice",
             "options": ["png", "jpeg"], "default": "png"},
            {"key": "seed", "label": "Seed", "kind": "number", "default": 0},
            {"key": "nsfw_checker", "label": "NSFW filter", "kind": "flag", "default": False},
        ],
    },
    "seedream_5_pro": {
        "id": "seedream/5-pro-image-to-image",
        "label": "Seedream 5.0 Pro",
        # kie's playground shows these capitalised, but the API only takes them
        # lower-case — "High" is answered with "quality is not within the range of
        # allowed options" (measured). The labels are for reading, the values are
        # what travels.
        "fields": [
            {"key": "quality", "label": "Quality", "kind": "choice",
             "options": ["basic", "high"], "labels": {"basic": "Basic (1K)", "high": "High (2K)"},
             "default": "high"},
            {"key": "nsfw_checker", "label": "NSFW filter", "kind": "flag", "default": False},
        ],
    },
    "nano_banana_2": {
        "id": "nano-banana-2",
        "label": "Nano Banana 2",
        "fields": [],
    },
}
DEFAULT_MODEL = "gpt_image_2"


def defaults_for(model: str) -> dict[str, Any]:
    spec = IMAGE_MODELS.get(model) or IMAGE_MODELS[DEFAULT_MODEL]
    return {f["key"]: f["default"] for f in spec["fields"]}


def payload_for(model: str, prompt: str, ref_url: str,
                params: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    """The request body this model expects, with the shape already decided.

    A character sheet is 9:16 by rule: a standing figure drawn into a square is a
    small figure with air on both sides, and the whole point of this picture is
    that the person is head to foot and big enough to see. The ratio is therefore
    not a setting — it is the same in every branch below, spelled the way each
    model spells it.
    """
    spec = IMAGE_MODELS.get(model) or IMAGE_MODELS[DEFAULT_MODEL]
    p = {**defaults_for(model), **(params or {})}

    if model == "gpt_image_2":
        body = {"prompt": prompt, "input_urls": [ref_url],
                "aspect_ratio": "9:16", "resolution": p.get("resolution", "2K")}
    elif model == "qwen_image_2":
        body = {"prompt": prompt, "image_url": [ref_url], "image_size": "9:16",
                "output_format": p.get("output_format", "png"),
                "nsfw_checker": bool(p.get("nsfw_checker", False))}
        if int(p.get("seed") or 0):
            body["seed"] = int(p["seed"])
    elif model == "seedream_5_pro":
        # no output_format: it is optional, its spelling is unverified, and a
        # wrong one costs a refusal — the default is a PNG either way
        body = {"prompt": prompt, "image_urls": [ref_url], "aspect_ratio": "9:16",
                "quality": p.get("quality", "high"),
                "nsfw_checker": bool(p.get("nsfw_checker", False))}
    else:
        body = {"prompt": prompt, "image_urls": [ref_url], "aspect_ratio": "9:16"}
    return spec["id"], body
