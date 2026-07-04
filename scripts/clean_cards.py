#!/usr/bin/env python3
"""One-off cleanup of data/cards.json:
  * remove non-vocabulary tokens (single letters, unit abbreviations);
  * resolve cross-references that point at a word already in the deck;
  * apply manual translations for real words whose Mueller entry is broken.
Run: python scripts/clean_cards.py
"""
import json
import re
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PATH = os.path.join(ROOT, "data", "cards.json")

# --- Same gloss parser as the app (scripts/app.js parseSenses) ---------------
def clean_gloss(chunk):
    c = (chunk or "").strip()
    prev = None
    while c and c != prev:
        prev = c
        c = re.sub(r"^[a-zа-яё-]{1,6}\.\s+", "", c, flags=re.I)
        c = re.sub(r"^\([^)]*\)\s*", "", c)
    m = re.search(r"[а-яё]", c, re.I)
    if not m:
        return ""
    c = c[m.start():]
    m2 = re.search(r"[A-Za-z]{2,}", c)
    if m2:
        c = c[:m2.start()]
    c = c.strip(" ;,.–-")
    return c if len(c) >= 2 else ""

def parse_senses(text):
    t = (text or "").strip()
    if not t:
        return []
    out, seen = [], set()
    for p in re.split(r"\s*\b\d+[.)]\s*", t):
        g = clean_gloss(p)
        if g and g.lower() not in seen:
            seen.add(g.lower())
            out.append(g)
    return out

# --- Cleanup rules -----------------------------------------------------------
REMOVE_WORDS = {
    # single letters used as letters
    "a", "I", "K", "l", "p", "g",
    # unit / misc abbreviations, not vocabulary
    "cm", "km", "mm", "mg", "gm", "kg", "c.", "ct.", "pt.", "etc.", "ad",
    "CD", "TV", "OK",
}

# Real words whose stored translation is corrupted/US-spelling — fixed by hand.
MANUAL = {
    "advertising": "реклама; рекламный",
    "afterward": "потом, впоследствии",
    "amused": "довольный, весёлый; позабавленный",
    "anyway": "в любом случае; так или иначе",
    "basketball": "баскетбол",
    "blond": "белокурый, светловолосый; блондин",
    "center": "центр; середина",
    "centimeter": "сантиметр",
    "color": "цвет; краска; окраска",
    "comfortably": "удобно, комфортно",
    "confusing": "сбивающий с толку, запутанный",
    "connection": "связь; соединение",
    "considerably": "значительно, существенно",
    "controlled": "контролируемый; управляемый",
    "everyone": "каждый; все",
    "excited": "взволнованный, возбуждённый",
    "excluding": "исключая, за исключением",
    "favor": "одолжение; благосклонность; предпочтение",
    "flavor": "вкус; аромат; привкус",
    "gambling": "азартные игры",
    "grandparent": "дедушка или бабушка",
    "hello": "привет; здравствуйте",
    "hers": "её (принадлежащий ей)",
    "hi": "привет",
    "humor": "юмор; настроение",
    "irritated": "раздражённый",
    "judgment": "суждение; мнение; приговор",
    "kilometer": "километр",
    "labor": "труд; работа; рабочая сила",
    "liter": "литр",
    "meanwhile": "тем временем; между тем",
    "oh": "о!; ах! (восклицание)",
    "ours": "наш (принадлежащий нам)",
    "percent": "процент",
    "smoking": "курение",
    "terribly": "ужасно; очень",
    "theater": "театр",
    "theirs": "их (принадлежащий им)",
    "uncontrolled": "неконтролируемый; неуправляемый",
    "underwater": "подводный; под водой",
    "yours": "ваш; твой (принадлежащий вам)",
    # cross-references that resolved poorly (adverb → base adjective, etc.)
    "furthest": "самый дальний; самый далёкий",
    "thickly": "толсто; густо; плотно",
    "tightly": "плотно; туго; крепко",
    "tonight": "сегодня вечером; сегодня ночью",
    "until": "до; до тех пор пока (не)",
}

def main():
    cards = json.load(open(PATH, encoding="utf-8"))
    by_word = {c["word"].lower(): c for c in cards}

    def resolve(text, depth=0):
        m = re.match(r"^(?:ам\.|брит\.)?\s*=\s*([a-zA-Z]+)", text.strip())
        if m and depth < 3:
            tgt = by_word.get(m.group(1).lower())
            if tgt:
                return resolve(tgt["translation"], depth + 1)
        return text

    removed, manual_fixed, xref_fixed = [], [], []
    out = []
    for c in cards:
        w = c["word"]
        if w in REMOVE_WORDS:
            removed.append(w)
            continue
        if w in MANUAL:
            c["translation"] = MANUAL[w]
            c["source"] = "manual"
            manual_fixed.append(w)
        else:
            resolved = resolve(c["translation"])
            if resolved != c["translation"] and parse_senses(resolved):
                c["translation"] = resolved
                xref_fixed.append(w)
        out.append(c)

    # Verify nothing broken remains
    still_broken = [c["word"] for c in out if not parse_senses(c["translation"])]

    json.dump(out, open(PATH, "w", encoding="utf-8"), ensure_ascii=False, indent=2)

    print(f"cards: {len(cards)} -> {len(out)}")
    print(f"removed non-words ({len(removed)}): {removed}")
    print(f"manual translations ({len(manual_fixed)})")
    print(f"cross-refs resolved ({len(xref_fixed)}): {xref_fixed}")
    print(f"still broken after cleanup: {len(still_broken)} {still_broken}")

if __name__ == "__main__":
    main()
