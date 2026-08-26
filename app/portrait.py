"""Reading a character out of a picture, and drawing them again in a style.

Two steps, and the first one is the reason the second one works. A model handed a
photograph and told "redraw this in style X" keeps whatever it thinks matters and
quietly drops the rest — the tattoo, the odd shoelaces, the patch on the sleeve.
A model handed a *written list of features* has to account for them.

So the picture is read first, into plain prose about the person and nothing else:
no background, no lighting, no composition, because every word spent on the room
is a word the drawing will spend on the room too. That description is then shown
to the user, who can correct a word far more cheaply than they can regenerate an
image.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Optional

from . import generate, looks
from .beautify import _ask

READ_MODEL = "gemini-2.5-flash"

READ_SYSTEM = """You describe the person in a picture so that an illustrator who
has never seen it could draw them from your words alone.

Describe ONLY the person. Not the background, not the room, not the lighting, not
the composition, not the mood of the photograph. If the picture is cropped, say
what is visible and do not invent the rest.

Cover, in this order and as one flowing paragraph:
- apparent age, build and height;
- face: shape, skin tone, eyes, eyebrows, nose, mouth, facial hair, freckles,
  moles, scars, glasses;
- hair: length, cut, texture, colour, how it is worn;
- clothing, layer by layer, with colours, materials, patterns, fit and any
  lettering or graphics on it;
- shoes;
- accessories: jewellery, watch, bag, hat, headphones, anything held;
- tattoos and body art, with where they are and what they show;
- anything else that would let someone recognise this person.

Be specific about colour and material. No preamble, no headings, no bullet
points, no guesses about who the person is or how they feel. Just the description."""


DRAW_TEMPLATE = (
    "Full-body character sheet of one character, standing upright, facing the "
    "viewer, the whole body from head to feet inside the frame, on a plain pure "
    "white background with no scenery, no props, no shadow behind them, and no "
    "lettering anywhere.\n\n"
    "The character: {who}\n\n"
    "Drawn in this style: {look}\n\n"
    "Keep the character's identity, clothing, hair and every marking exactly as "
    "described, and only change how it is drawn. The reference usually shows only "
    "part of the person: draw everything the description does not mention — legs, "
    "trousers, shoes, hands — completely and plausibly, in keeping with what is "
    "described, so the figure is whole and dressed. Nobody is barefoot unless the "
    "description says so. Tall upright composition, the figure centred and filling "
    "the height of the frame from head to feet."
)


def as_data_uri(path: Path) -> str:
    """A picture the model can read without anyone hosting it.

    Text models here accept a data: URI (measured), which means the reading step
    depends on no upload host at all — and every host we use has been down at
    some point this week.
    """
    import base64
    kind = "png" if path.suffix.lower() == ".png" else "jpeg"
    return f"data:image/{kind};base64," + base64.b64encode(path.read_bytes()).decode()


def read_character(key: str, image_url: str) -> str:
    """What the person in this picture looks like, in words."""
    messages = [
        {"role": "system", "content": READ_SYSTEM},
        {"role": "user", "content": [
            {"type": "text", "text": "Describe the person in this picture."},
            {"type": "image_url", "image_url": {"url": image_url}},
        ]},
    ]
    text = _ask(key, messages, model=READ_MODEL)
    return text.strip()


def draw_prompt(who: str, style_id: str) -> str:
    style = looks.STYLE_BY_ID.get(style_id) or looks.STYLES[0]
    return DRAW_TEMPLATE.format(who=who.strip(), look=style["look"])


def redraw(key: str, model: str, prompt: str, ref_url: str,
           params: dict[str, Any], dst: Path, progress=None) -> Path:
    """The character again, in the chosen style, kept on disk."""
    say = progress or (lambda *a, **k: None)
    model_id, body = looks.payload_for(model, prompt, ref_url, params)
    generate.note(f"redraw {model_id}\n{json.dumps(body, ensure_ascii=False)[:600]}")
    answer = generate._call(key, "POST", "/api/v1/jobs/createTask",
                            {"model": model_id, "input": body})
    task = (answer.get("data") or {}).get("taskId")
    if not task:
        raise RuntimeError(answer.get("msg") or "the picture model would not take the job")
    url = generate.wait(key, task, say, "Drawing the character")
    return generate.fetch(url, dst)
