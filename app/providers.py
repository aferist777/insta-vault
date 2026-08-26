"""Talking to the paid services.

Keys are never stored here. The browser keeps them in its own storage and sends
the one key a job needs with that job, so the server stays as stateless as it is
for everything else — and a key never lands in a file or a log on this machine.

For now this module only answers "is this key any good?"; the actual model calls
land here as the AI actions are switched on.
"""
from __future__ import annotations

from typing import Any

import requests

TIMEOUT = 20

# imgbb has no "check my key" endpoint, so the cheapest honest test is a real
# upload that deletes itself a minute later. It must be a *real* picture: a 1x1
# png comes back as "You have been forbidden to use this website" (code 103),
# which reads exactly like a dead key and is nothing of the sort.
_PROBE_PNG = ("iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAAJklEQVR42mNkYGjgYmCgHLEw"
              "cDFQBYwaNGrQqEGjBo0aNGoQ+QAAydECqrPG8eAAAAAASUVORK5CYII=")


class ProviderError(Exception):
    pass


def _bearer(key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}


def _money(value: Any) -> str:
    try:
        return f"{float(value):,.2f}"
    except (TypeError, ValueError):
        return str(value)


def _why(r: requests.Response, fallback: str = "") -> str:
    """The provider's own words, so a refusal says what to fix."""
    try:
        body = r.json()
    except ValueError:
        return fallback or f"rejected ({r.status_code})"
    for path in (("error", "message"), ("detail", "message"), ("message",), ("msg",), ("detail",)):
        node: Any = body
        for step in path:
            node = node.get(step) if isinstance(node, dict) else None
        if isinstance(node, str) and node:
            return f"{node} ({r.status_code})"
    return fallback or f"rejected ({r.status_code})"


def test_key(provider: str, key: str) -> dict[str, Any]:
    """Ask the provider whether the key works. Returns {ok, detail}."""
    key = (key or "").strip()
    if not key:
        return {"ok": False, "detail": "No key given"}

    try:
        if provider == "replicate":
            r = requests.get("https://api.replicate.com/v1/account",
                             headers=_bearer(key), timeout=TIMEOUT)
            if r.status_code == 200:
                who = r.json().get("username") or r.json().get("name") or "account"
                return {"ok": True, "detail": f"signed in as {who}"}
            return {"ok": False, "detail": _why(r)}

        if provider == "openrouter":
            r = requests.get("https://openrouter.ai/api/v1/key",
                             headers=_bearer(key), timeout=TIMEOUT)
            if r.status_code == 200:
                d = r.json().get("data") or {}
                limit, used = d.get("limit"), d.get("usage")
                if limit is None:
                    return {"ok": True, "detail": f"valid · used ${_money(used or 0)}"}
                return {"ok": True, "detail": f"valid · ${_money(max(0, (limit or 0) - (used or 0)))} left"}
            return {"ok": False, "detail": _why(r)}

        if provider == "groq":
            r = requests.get("https://api.groq.com/openai/v1/models",
                             headers=_bearer(key), timeout=TIMEOUT)
            if r.status_code == 200:
                names = [m.get("id", "") for m in (r.json().get("data") or [])]
                whisper = [n for n in names if "whisper" in n]
                return {"ok": True, "detail": f"valid · {len(whisper)} whisper model(s)"
                        if whisper else "valid, but no whisper model listed"}
            return {"ok": False, "detail": _why(r)}

        if provider == "kie":
            r = requests.get("https://api.kie.ai/api/v1/chat/credit",
                             headers=_bearer(key), timeout=TIMEOUT)
            if r.status_code == 200 and int(r.json().get("code", 0)) == 200:
                return {"ok": True, "detail": f"valid · {r.json().get('data')} credits"}
            return {"ok": False, "detail": _why(r)}

        if provider == "elevenlabs":
            # A header of its own, not a bearer token — and keys are scoped, so a
            # perfectly good speech key is refused by /user and /models. Voices is
            # the one thing every key may read; the balance is a bonus on top.
            head = {"xi-api-key": key}
            r = requests.get("https://api.elevenlabs.io/v1/voices", headers=head, timeout=TIMEOUT)
            if r.status_code != 200:
                return {"ok": False, "detail": _why(r)}
            count = len(r.json().get("voices") or [])
            sub = requests.get("https://api.elevenlabs.io/v1/user/subscription",
                               headers=head, timeout=TIMEOUT)
            if sub.status_code == 200:
                d = sub.json()
                used, limit = d.get("character_count"), d.get("character_limit")
                tier = d.get("tier") or "account"
                if isinstance(used, int) and isinstance(limit, int):
                    return {"ok": True, "detail": f"{tier} · {limit - used:,} characters left"}
            return {"ok": True, "detail": f"valid · {count} voices · balance hidden by key permissions"}

        if provider == "imgbb":
            r = requests.post("https://api.imgbb.com/1/upload",
                              data={"key": key, "image": _PROBE_PNG, "expiration": 60},
                              timeout=TIMEOUT)
            if r.status_code == 200 and r.json().get("success"):
                return {"ok": True, "detail": "valid · test upload accepted"}
            return {"ok": False, "detail": _why(r)}

    except requests.RequestException as exc:
        return {"ok": False, "detail": f"could not reach the service: {exc.__class__.__name__}"}

    return {"ok": False, "detail": f"unknown provider “{provider}”"}
