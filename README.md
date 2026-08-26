# Insta Vault

Local archive for Instagram posts and reels: media files + captions + metadata,
stored inside the project folder and browsable in a native window.

## Run

```
run.bat
```

First launch creates `.venv` and installs dependencies. Add `--no-window` to run
headless and open `http://127.0.0.1:8765/` in a normal browser instead.

## How it works

- **instaloader** fetches post metadata and media URLs (photos, videos, carousels,
  caption, hashtags, likes/comments/views).
- **yt-dlp** is the automatic fallback if instaloader can't reach the post.
- Files land in `media/<shortcode>/` — `1.jpg`, `2.mp4`, … plus `thumb.jpg`,
  `caption.txt` and `meta.json`.
- **ffmpeg** (bundled via `imageio-ffmpeg`) builds editor assets: proxies,
  posters, filmstrips, waveform peaks, extracted audio — all under `assets/<id>/`.
- The editor renders the timeline back through ffmpeg into `renders/` — one
  `filter_complex` carrying trim, speed, fit, position, colour, opacity, blend,
  volume and fades, so the file matches the preview.

## Where data lives

The server is stateless. Everything the app remembers — the archive index,
settings, panel layout and editor projects — lives in this window's
**localStorage**, which is why:

- the port is fixed at 8765 (localStorage is bound to the origin), and
- the window runs with `private_mode=False` and `data/webview` as its storage
  path, so it survives restarts.

`media/<shortcode>/meta.json` and `assets/<id>/asset.json` are the durable copies
on disk: **Vault → Rescan media folder** rebuilds the whole index from them, and
the asset list re-syncs from disk every time the Editor opens. **Vault → Export
all data** writes a full JSON backup.

## Optional auth

Public posts work anonymously. For rate-limit relief or restricted content copy
`.env.example` to `.env`:

- `IG_COOKIES_FROM_BROWSER=chrome` — yt-dlp reuses the browser session.
- `IG_USERNAME=...` + an instaloader session file at `data/ig_session`.

## Layout

```
app/config.py       paths, port, user agent
app/downloader.py   instaloader + yt-dlp engines
app/media_tools.py  ffmpeg: probe, proxy, poster, filmstrip, peaks
app/assets.py       editor assets (import, extract audio, scan)
app/api.py          FastAPI routes + job queue
app/main.py         uvicorn thread + pywebview window
web/store.js        localStorage: index, settings, layout, projects, assets
web/                dark UI (index.html / styles.css / app.js)
```
