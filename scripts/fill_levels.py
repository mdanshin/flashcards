#!/usr/bin/env python3
"""Fill missing CEFR levels in data/cards.json from data/oxford-levels.json.

oxford-levels.json maps lowercased Oxford 3000/5000 headwords to their easiest
CEFR level (A1–C1), extracted from the Oxford word-list metadata
(data-ox3000 / data-ox5000). This only fills cards that currently have no
level; existing levels are left untouched.
Run: python scripts/fill_levels.py
"""
import json
import re
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CARDS = os.path.join(ROOT, "data", "cards.json")
LEVELS = os.path.join(ROOT, "data", "oxford-levels.json")

# Cards store American spellings for some words; the Oxford list is British.
AMERICAN_TO_BRITISH = {
    "analyze": "analyse", "apologize": "apologise", "organize": "organise",
    "realize": "realise", "recognize": "recognise", "memorize": "memorise",
    "color": "colour", "favor": "favour", "flavor": "flavour", "humor": "humour",
    "labor": "labour", "neighbor": "neighbour", "center": "centre",
    "theater": "theatre", "meter": "metre", "liter": "litre", "fiber": "fibre",
    "traveler": "traveller", "jewelry": "jewellery", "gray": "grey",
    "airplane": "aeroplane", "aluminum": "aluminium", "defense": "defence",
    "license": "licence", "practice": "practise", "check": "cheque",
    "tire": "tyre", "program": "programme",
}


def norm(word):
    word = word.strip().lower()
    return re.sub(r"\s+\d+$", "", word)  # drop homograph markers like "bid 1"


def main():
    levels = json.load(open(LEVELS, encoding="utf-8"))
    cards = json.load(open(CARDS, encoding="utf-8"))

    filled = 0
    for card in cards:
        if card.get("level"):
            continue
        base = norm(card["word"])
        for key in (card["word"].lower(), base, AMERICAN_TO_BRITISH.get(base, "")):
            if key and key in levels:
                card["level"] = levels[key]
                filled += 1
                break

    json.dump(cards, open(CARDS, "w", encoding="utf-8"), ensure_ascii=False, indent=2)

    from collections import Counter
    dist = Counter(c.get("level") for c in cards)
    print(f"filled {filled} missing levels")
    for lvl in ["A1", "A2", "B1", "B2", "C1", None]:
        print(f"  {lvl}: {dist.get(lvl, 0)}")


if __name__ == "__main__":
    main()
