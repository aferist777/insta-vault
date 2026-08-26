"""Entry point: run the local API in a thread, show it in a native webview window.

Two things here are load-bearing for storage, because all data lives in
localStorage:

* the port is fixed — localStorage is scoped to the origin, so silently moving
  to another port would look exactly like "the archive disappeared";
* the window runs with private_mode=False and its own storage_path, otherwise
  pywebview throws localStorage away on every restart.
"""
from __future__ import annotations

import socket
import sys
import threading
import time

import uvicorn

from . import api
from .config import DATA_DIR, HOST, PORT


def _port_is_free(port: int) -> bool:
    with socket.socket() as s:
        try:
            s.bind((HOST, port))
            return True
        except OSError:
            return False


def _serve(port: int) -> None:
    uvicorn.run(api.app, host=HOST, port=port, log_level="warning")


def _wait_for_server(port: int, timeout: float = 15.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        with socket.socket() as s:
            s.settimeout(0.5)
            if s.connect_ex((HOST, port)) == 0:
                return True
        time.sleep(0.15)
    return False


def main() -> None:
    if not _port_is_free(PORT):
        print(
            f"Port {PORT} is busy. Insta Vault always uses this port because the whole\n"
            f"archive lives in localStorage, which is bound to http://{HOST}:{PORT}.\n"
            f"Close whatever holds the port (probably another Insta Vault window) and retry.",
            file=sys.stderr,
        )
        sys.exit(1)

    url = f"http://{HOST}:{PORT}/"
    threading.Thread(target=_serve, args=(PORT,), daemon=True).start()
    if not _wait_for_server(PORT):
        print("Server failed to start", file=sys.stderr)
        sys.exit(1)

    if "--no-window" in sys.argv:
        print(f"Insta Vault running at {url}  (Ctrl+C to stop)")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            return

    import webview

    storage = DATA_DIR / "webview"
    storage.mkdir(parents=True, exist_ok=True)
    api.WINDOW = webview.create_window(
        "Insta Vault",
        url,
        width=1440,          # size used if the window is ever restored down
        height=900,
        min_size=(1100, 680),
        maximized=True,      # open filling the screen; --fullscreen drops the title bar too
        fullscreen="--fullscreen" in sys.argv,
        background_color="#0d0f14",
    )
    webview.start(private_mode=False, storage_path=str(storage))


if __name__ == "__main__":
    main()
