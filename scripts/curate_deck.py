#!/usr/bin/env python3
"""Curate data/cards.json: drop non-vocabulary entries and collapse inflected
forms onto a base word that already exists in the deck.

Removes:
  * abbreviations / titles (a dot in the word): Mr., a.m., e.g. …
  * multi-word phrases and phrasal verbs: "add up", "post office" …
  * inflected/derived forms whose base word is already present and that Oxford
    does not list separately (i.e. the card has no CEFR level): amused→amuse …

Everything with a CEFR level and every real single word is kept.
Run: python scripts/curate_deck.py
"""
import json
import re
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CARDS = os.path.join(ROOT, "data", "cards.json")


def base_candidates(word):
    w = word.lower()
    c = set()
    if w.endswith("ied"):
        c.add(w[:-3] + "y")
    if w.endswith("ies"):
        c.add(w[:-3] + "y")
    if w.endswith("ed"):
        c.add(w[:-2])
        c.add(w[:-1])
        if len(w) > 4 and w[-3] == w[-4]:
            c.add(w[:-3])
    if w.endswith("ing"):
        c.add(w[:-3])
        c.add(w[:-3] + "e")
        if len(w) > 5 and w[-4] == w[-5]:
            c.add(w[:-4])
    if w.endswith("ily"):
        c.add(w[:-3] + "y")
    if w.endswith("ly"):
        c.add(w[:-2])
    if w.endswith("es"):
        c.add(w[:-2])
        c.add(w[:-1])
    elif w.endswith("s") and not w.endswith("ss"):
        c.add(w[:-1])
    c.discard(w)
    return {x for x in c if len(x) >= 3}


LEVEL_ORDER = {"A1": 0, "A2": 1, "B1": 2, "B2": 3, "C1": 4}


def easier(a, b):
    if a and b:
        return a if LEVEL_ORDER.get(a, 9) <= LEVEL_ORDER.get(b, 9) else b
    return a or b


def main():
    cards = json.load(open(CARDS, encoding="utf-8"))
    deck = {c["word"].lower() for c in cards}

    kept, removed = [], {"abbrev": [], "phrase": [], "inflected": []}
    for card in cards:
        word = card["word"]
        if "." in word:
            removed["abbrev"].append(word)
            continue
        if " " in word and not re.search(r"\s+\d+$", word):
            removed["phrase"].append(word)
            continue
        if not card.get("level"):
            base = next((b for b in base_candidates(word) if b in deck), None)
            if base:
                removed["inflected"].append(f"{word} → {base}")
                continue
        kept.append(card)

    # Strip Oxford homograph markers ("close 1" → "close") and merge duplicates,
    # combining their translations so no two cards share a word.
    merged, order = {}, []
    for card in kept:
        card["word"] = re.sub(r"\s+\d+$", "", card["word"]).strip()
        word = card["word"]
        if word not in merged:
            merged[word] = card
            order.append(word)
        else:
            target = merged[word]
            extra = card.get("translation", "").strip()
            if extra and extra not in target.get("translation", ""):
                target["translation"] = f"{target['translation'].rstrip('. ')}; {extra}"
            target["level"] = easier(target.get("level"), card.get("level"))
            target["pos"] = list(dict.fromkeys((target.get("pos") or []) + (card.get("pos") or [])))
            if not target.get("oxford_urls"):
                target["oxford_urls"] = card.get("oxford_urls")
    kept = [merged[w] for w in order]

    json.dump(kept, open(CARDS, "w", encoding="utf-8"), ensure_ascii=False, indent=2)

    total_removed = sum(len(v) for v in removed.values())
    print(f"cards: {len(cards)} -> {len(kept)} (removed {total_removed}, plus merges)")
    for name, items in removed.items():
        print(f"  {name}: {len(items)}")


if __name__ == "__main__":
    main()
