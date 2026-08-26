"""Paths and settings for Insta Vault."""
from pathlib import Path
import os

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = ROOT / "web"
MEDIA_DIR = ROOT / "media"
ASSETS_DIR = ROOT / "assets"
RENDERS_DIR = ROOT / "renders"
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "vault.db"
SESSION_FILE = DATA_DIR / "ig_session"

load_dotenv(ROOT / ".env")

HOST = "127.0.0.1"
PORT = int(os.getenv("VAULT_PORT", "8765"))

# Instagram serves media from a CDN that rejects unknown clients.
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
)

THUMB_MAX = 640

for _d in (MEDIA_DIR, ASSETS_DIR, RENDERS_DIR, DATA_DIR):
    _d.mkdir(parents=True, exist_ok=True)
