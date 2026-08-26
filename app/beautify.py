"""Turning a handful of settings into a prompt the video model understands.

The panel collects switches and a line of free text; a video model wants one
paragraph of plain description. Rather than glue the two together with string
concatenation and hope, the pieces are handed to a small, fast language model
that writes the paragraph — including whatever the user typed in their own words,
in whatever language they typed it.

kie.ai serves text models on an OpenAI-shaped endpoint of their own, one path per
model: POST https://api.kie.ai/<model>/v1/chat/completions (measured against the
live API — the flat /v1/chat/completions of the OpenAI world answers 404 there).
"""
from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from typing import Any, Optional

BASE = "https://api.kie.ai"
MODEL = "gemini-2.5-flash"
TIMEOUT = 60

SYSTEM = """You write prompts for a video generation model.

You are given the settings a video editor has chosen for one shot, an inventory of
the reference files that will be sent with the prompt, and possibly a note from
the user in their own words. Turn all of it into ONE paragraph of plain English
describing what the model should produce.

Referring to the references is the important part. Each one has a token such as
@Image1 or @Video1 — written with no space before the number. Put every token in
the sentence **right next to the thing it describes** — "replace the face with the
face in @Image1", "keep the motion of @Video1" — the way a caption points at a
picture. Use each token exactly once, exactly as given, never invent a token that
is not in the inventory, and never renumber them.

Rules:
- The finished shot must have no lettering in the frame — no captions and no
  subtitles — and wherever the source shows text, the scene behind it is shown
  instead. Say this plainly, but never use the words watermark, logo, brand or
  copyright: the video model refuses the whole job when it reads them.
- Describe the result, never the interface: no settings, sliders or checkboxes.
- Keep every instruction given, including the user's note, whatever language it is
  written in; translate it into English.
- Add nothing of your own. No invented lighting, mood, lens or style.
- Say plainly what must stay unchanged from the source footage.
- No preamble, no explanation, no quotes, no markdown. Only the paragraph.
- Under 90 words."""

TOKEN = re.compile(r"@\s*(Image|Video|Audio)\s*(\d+)", re.I)

# How a reference is written in the prompt. kie's own playground example spaces
# it — “perspective reference @Image 1” — but the space is what we send, and it
# is one string to change if the parser turns out to want it back.
JOIN = ""            # "" → @Image1, " " → @Image 1


def canon(text: str) -> str:
    """Write every reference token one way, whatever the model produced.

    @image1, @ Image  1 and @IMAGE 1 all mean the same to a reader and possibly
    nothing at all to a parser, so the spelling is settled here rather than hoped
    for.
    """
    return TOKEN.sub(lambda m: f"@{m.group(1).title()}{JOIN}{int(m.group(2))}", text)


def token(kind: str, n: int) -> str:
    return f"@{kind.title()}{JOIN}{n}"


def _ask(key: str, messages: list[dict[str, Any]], model: str = "") -> str:
    """One turn with a kie.ai text model.

    The model is a parameter because the app now uses more than one: this file's
    default writes video prompts, while the poem pipeline wants one that can be
    shown a picture. Measured names, since they are not guessable —
    `gemini-3-6-flash-openai` is the 3.6 that answers at all, and `gemini-3-flash`
    is the one with live web access.
    """
    body = json.dumps({"stream": False, "messages": messages}).encode()
    req = urllib.request.Request(f"{BASE}/{model or MODEL}/v1/chat/completions", data=body, method="POST",
                                 headers={"Authorization": f"Bearer {key}",
                                          "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        data = json.loads(r.read().decode("utf-8", "replace"))
    if data.get("code") and data.get("code") != 200:
        raise ValueError(data.get("msg") or "the model refused the request")
    text = ((data.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
    text = text.strip().strip('"')
    if not text:
        raise ValueError("the model answered with nothing")
    return canon(text)


def check(text: str, tokens: list[str]) -> list[str]:
    """Which reference tokens are missing, doubled or invented."""
    found = [token(k, int(n)) for k, n in TOKEN.findall(text)]
    problems = []
    for want in tokens:
        n = found.count(want)
        if n == 0:
            problems.append(f"{want} is missing")
        elif n > 1:
            problems.append(f"{want} appears {n} times")
    for got in set(found) - set(tokens):
        problems.append(f"{got} is not one of the references")
    return problems


def compose(key: str, tool: str, facts: dict[str, Any],
            refs: Optional[list[dict[str, str]]] = None) -> dict[str, Any]:
    """Write the prompt for one tool from the settings behind it.

    The model places the reference tokens itself, because where a token sits is
    what says which picture belongs to which part of the sentence — something only
    the writer of the sentence knows. It is then checked, asked again once if it
    got it wrong, and only failing that patched by hand, which is a last resort
    rather than the plan.
    """
    refs = refs or []
    tokens = [r["token"] for r in refs]
    lines = [f"Tool: {tool}."]
    if refs:
        lines.append("References sent with this prompt:")
        lines += [f"  {r['token']} — {r['what']}" for r in refs]
    for label, value in facts.items():
        if value in (None, "", [], False):
            continue
        if value is True:
            lines.append(f"{label}: yes")
        elif isinstance(value, list):
            lines.append(f"{label}: {', '.join(str(v) for v in value)}")
        else:
            lines.append(f"{label}: {value}")
    ask = "\n".join(lines)

    messages = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": ask}]
    text = _ask(key, messages)
    problems = check(text, tokens)
    note = ""
    if problems:
        messages += [
            {"role": "assistant", "content": text},
            {"role": "user", "content": "That answer is wrong about the references: "
             + "; ".join(problems) + ". Write the paragraph again, using exactly these tokens, "
             "each once, each beside the thing it describes: " + ", ".join(tokens)},
        ]
        text = _ask(key, messages)
        problems = check(text, tokens)
        note = "" if not problems else "asked twice"
    if problems:                                  # still wrong: say it plainly and patch
        for want in tokens:
            if want not in text:
                text = f"{text.rstrip('.')}. Reference: {want}."
        note = "the reference was added by hand — check where it sits"
    return {"prompt": text, "note": note, "tokens": tokens}
