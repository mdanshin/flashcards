"""Flashcards API — stores imported Anki decks and their study progress.

Auth: the browser sends a Firebase ID token as `Authorization: Bearer <token>`;
we verify it against Google's public keys and key everything by the user's uid.
Decks are uploaded as .apkg files and parsed here (stdlib zipfile + sqlite3).
"""
import os
import io
import re
import json
import html
import time
import zipfile
import sqlite3
import tempfile

import requests
import jwt
from cryptography.x509 import load_pem_x509_certificate
from fastapi import FastAPI, UploadFile, File, Depends, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

PROJECT_ID = "flashcards-706bb"
ALLOWED_ORIGINS = ["https://danshin.ms"]
DB_PATH = os.environ.get("FLASHCARDS_DB", "/opt/flashcards-api/data/app.db")
MAX_UPLOAD = 40 * 1024 * 1024  # 40 MB
FIREBASE_CERTS_URL = (
    "https://www.googleapis.com/robot/v1/metadata/x509/"
    "securetoken@system.gserviceaccount.com"
)

# --- Firebase ID token verification -----------------------------------------
_certs_cache = {"exp": 0.0, "keys": {}}


def _firebase_public_keys():
    now = time.time()
    if now < _certs_cache["exp"] and _certs_cache["keys"]:
        return _certs_cache["keys"]
    resp = requests.get(FIREBASE_CERTS_URL, timeout=10)
    resp.raise_for_status()
    keys = resp.json()
    m = re.search(r"max-age=(\d+)", resp.headers.get("Cache-Control", ""))
    _certs_cache["exp"] = now + (int(m.group(1)) if m else 3600)
    _certs_cache["keys"] = keys
    return keys


def verify_token(token: str) -> str:
    try:
        kid = jwt.get_unverified_header(token).get("kid")
        cert_pem = _firebase_public_keys().get(kid)
        if not cert_pem:
            raise ValueError("unknown key id")
        public_key = load_pem_x509_certificate(cert_pem.encode()).public_key()
        claims = jwt.decode(
            token,
            public_key,
            algorithms=["RS256"],
            audience=PROJECT_ID,
            issuer=f"https://securetoken.google.com/{PROJECT_ID}",
        )
        uid = claims.get("user_id") or claims.get("sub")
        if not uid:
            raise ValueError("token has no uid")
        return uid
    except Exception as exc:  # noqa: BLE001 — any failure means unauthorized
        raise HTTPException(status_code=401, detail=f"invalid token: {exc}")


def current_uid(authorization: str = Header(None)) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    return verify_token(authorization[len("Bearer "):])


# --- storage ----------------------------------------------------------------
def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = db()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS decks(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          uid TEXT NOT NULL,
          name TEXT NOT NULL,
          count INTEGER DEFAULT 0,
          created_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS cards(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          deck_id INTEGER NOT NULL,
          ord INTEGER,
          front TEXT,
          back TEXT
        );
        CREATE TABLE IF NOT EXISTS progress(
          uid TEXT NOT NULL,
          deck_id INTEGER NOT NULL,
          data TEXT,
          updated_at INTEGER,
          PRIMARY KEY(uid, deck_id)
        );
        CREATE INDEX IF NOT EXISTS idx_cards_deck ON cards(deck_id);
        CREATE INDEX IF NOT EXISTS idx_decks_uid ON decks(uid);
        """
    )
    conn.commit()
    conn.close()


# --- .apkg parsing (Basic front/back) ---------------------------------------
CLOZE_RE = re.compile(r"\{\{c\d+::(.+?)\}\}", re.S)


def cloze_render(text: str, reveal: bool) -> str:
    """Turn Anki cloze markup into a front (deletion hidden) or back (revealed)."""
    def repl(match):
        inner = match.group(1)
        if "::" in inner:
            answer, hint = inner.split("::", 1)
        else:
            answer, hint = inner, None
        return answer if reveal else f"[{hint or '…'}]"
    return CLOZE_RE.sub(repl, text)


def strip_html(text: str) -> str:
    if not text:
        return ""
    text = re.sub(r"(?i)<br\s*/?>", "\n", text)
    text = re.sub(r"(?i)</(div|p|li)>", "\n", text)
    text = re.sub(r"\[sound:[^\]]+\]", "", text)  # Anki media refs
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def parse_apkg(file_bytes: bytes):
    try:
        zf = zipfile.ZipFile(io.BytesIO(file_bytes))
    except zipfile.BadZipFile:
        raise HTTPException(400, "файл не является .apkg (не ZIP)")
    names = zf.namelist()
    dbname = next((n for n in ("collection.anki21", "collection.anki2") if n in names), None)
    if not dbname:
        if "collection.anki21b" in names:
            raise HTTPException(
                400,
                "Новый формат Anki. При экспорте в Anki включите «Support older "
                "Anki versions» и загрузите файл заново.",
            )
        raise HTTPException(400, "в .apkg нет базы коллекции")

    tmp = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".anki2", delete=False) as handle:
            handle.write(zf.read(dbname))
            tmp = handle.name
        conn = sqlite3.connect(tmp)
        conn.row_factory = sqlite3.Row
        col = conn.execute("SELECT decks FROM col LIMIT 1").fetchone()

        deck_name = "Импортированная колода"
        try:
            decks = json.loads(col["decks"])
            named = [d["name"] for d in decks.values() if d.get("name") and d["name"] != "Default"]
            if named:
                deck_name = named[0]
        except Exception:  # noqa: BLE001
            pass

        cards = []
        for i, row in enumerate(conn.execute("SELECT flds FROM notes")):
            flds = row["flds"].split("\x1f")
            raw = flds[0] if flds else ""
            if CLOZE_RE.search(raw):
                # Cloze note: hide the deletion on the front, reveal it on the back.
                front = strip_html(cloze_render(raw, reveal=False))
                back = strip_html(cloze_render(raw, reveal=True))
                extra = strip_html(flds[1]) if len(flds) >= 2 else ""
                if extra:
                    back = f"{back}\n\n{extra}"
            else:
                front = strip_html(raw)
                back = strip_html(flds[1]) if len(flds) >= 2 else ""
                if not back and len(flds) > 2:
                    back = strip_html(" / ".join(flds[1:]))
            if front and back:
                cards.append({"ord": i, "front": front, "back": back})
        conn.close()
        return deck_name, cards
    finally:
        if tmp and os.path.exists(tmp):
            os.unlink(tmp)


# --- app --------------------------------------------------------------------
app = FastAPI(title="Flashcards API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)
init_db()


class ProgressBody(BaseModel):
    data: dict


@app.get("/api/health")
def health():
    return {"ok": True}


@app.post("/api/decks/import")
async def import_deck(file: UploadFile = File(...), uid: str = Depends(current_uid)):
    data = await file.read()
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, "файл слишком большой (максимум 40 МБ)")
    name, cards = parse_apkg(data)
    if not cards:
        raise HTTPException(400, "не найдено карточек с лицом и оборотом")
    conn = db()
    cur = conn.execute(
        "INSERT INTO decks(uid,name,count,created_at) VALUES(?,?,?,?)",
        (uid, name, len(cards), int(time.time())),
    )
    deck_id = cur.lastrowid
    conn.executemany(
        "INSERT INTO cards(deck_id,ord,front,back) VALUES(?,?,?,?)",
        [(deck_id, c["ord"], c["front"], c["back"]) for c in cards],
    )
    conn.commit()
    conn.close()
    return {"id": deck_id, "name": name, "count": len(cards)}


@app.get("/api/decks")
def list_decks(uid: str = Depends(current_uid)):
    conn = db()
    rows = conn.execute(
        "SELECT id,name,count,created_at FROM decks WHERE uid=? ORDER BY created_at DESC",
        (uid,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.get("/api/decks/{deck_id}")
def get_deck(deck_id: int, uid: str = Depends(current_uid)):
    conn = db()
    deck = conn.execute(
        "SELECT id,name,count FROM decks WHERE id=? AND uid=?", (deck_id, uid)
    ).fetchone()
    if not deck:
        conn.close()
        raise HTTPException(404, "колода не найдена")
    cards = conn.execute(
        "SELECT id,ord,front,back FROM cards WHERE deck_id=? ORDER BY ord", (deck_id,)
    ).fetchall()
    conn.close()
    return {"id": deck["id"], "name": deck["name"], "count": deck["count"],
            "cards": [dict(c) for c in cards]}


@app.delete("/api/decks/{deck_id}")
def delete_deck(deck_id: int, uid: str = Depends(current_uid)):
    conn = db()
    deck = conn.execute("SELECT id FROM decks WHERE id=? AND uid=?", (deck_id, uid)).fetchone()
    if not deck:
        conn.close()
        raise HTTPException(404, "колода не найдена")
    conn.execute("DELETE FROM cards WHERE deck_id=?", (deck_id,))
    conn.execute("DELETE FROM progress WHERE deck_id=? AND uid=?", (deck_id, uid))
    conn.execute("DELETE FROM decks WHERE id=?", (deck_id,))
    conn.commit()
    conn.close()
    return {"ok": True}


@app.get("/api/decks/{deck_id}/progress")
def get_progress(deck_id: int, uid: str = Depends(current_uid)):
    conn = db()
    row = conn.execute(
        "SELECT data FROM progress WHERE uid=? AND deck_id=?", (uid, deck_id)
    ).fetchone()
    conn.close()
    return json.loads(row["data"]) if row and row["data"] else {}


@app.put("/api/decks/{deck_id}/progress")
def put_progress(deck_id: int, body: ProgressBody, uid: str = Depends(current_uid)):
    conn = db()
    deck = conn.execute("SELECT id FROM decks WHERE id=? AND uid=?", (deck_id, uid)).fetchone()
    if not deck:
        conn.close()
        raise HTTPException(404, "колода не найдена")
    conn.execute(
        "INSERT INTO progress(uid,deck_id,data,updated_at) VALUES(?,?,?,?) "
        "ON CONFLICT(uid,deck_id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at",
        (uid, deck_id, json.dumps(body.data), int(time.time())),
    )
    conn.commit()
    conn.close()
    return {"ok": True}
