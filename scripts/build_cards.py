#!/usr/bin/env python3
"""Generate Oxford 3000 flashcard dataset with Russian translations."""
from __future__ import annotations

import json
import re
from collections import defaultdict
from pathlib import Path
from dataclasses import dataclass
from typing import Dict, List, Optional
from urllib.request import urlretrieve

from bs4 import BeautifulSoup  # type: ignore

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
OXFORD_LIST_PATH = DATA_DIR / "oxford-3000.json"
OXFORD_HTML_PATH = ROOT / "oxford-3000" / "a.html"
OXFORD_HTML_URL = "https://raw.githubusercontent.com/samuraitruong/oxford-3000/master/a.html"
OUTPUT_PATH = DATA_DIR / "cards.json"

MUELLER_DICT_PATH = Path("/usr/share/dictd/mueller7.dict")
FREEDICT_PATH = Path("/usr/share/dictd/freedict-eng-rus.dict")

LEVEL_ORDER = {"A1": 0, "A2": 1, "B1": 2, "B2": 3}

AMERICAN_TO_BRITISH = {
    "analyze": "analyse",
    "analyzing": "analysing",
    "apologize": "apologise",
    "apologizing": "apologising",
    "behavior": "behaviour",
    "behavioral": "behavioural",
    "catalog": "catalogue",
    "center": "centre",
    "centered": "centred",
    "centimeter": "centimetre",
    "color": "colour",
    "colored": "coloured",
    "colorful": "colourful",
    "defense": "defence",
    "favorite": "favourite",
    "honor": "honour",
    "honored": "honoured",
    "humor": "humour",
    "kilometer": "kilometre",
    "labor": "labour",
    "liter": "litre",
    "meter": "metre",
    "millimeter": "millimetre",
    "offense": "offence",
    "organize": "organise",
    "organizing": "organising",
    "realize": "realise",
    "realizing": "realising",
    "recognize": "recognise",
    "recognizing": "recognising",
    "traveler": "traveller",
    "traveling": "travelling",
    "neighbor": "neighbour",
    "neighborhood": "neighbourhood",
    "neighboring": "neighbouring",
    "theater": "theatre",
    "gray": "grey",
    "rumor": "rumour",
    "license": "licence",
    "licensing": "licencing",
    "cooperation": "co-operation",
    "makeup": "make-up",
    "photocopy": "photo-copy",
}

MANUAL_TRANSLATIONS = {
    "internet": "интернет",
    "a.m.": "до полудня; время от полуночи до полудня",
    "activist": "активист; общественный деятель",
    "anymore": "(больше) уже не; более не",
    "boyfriend": "парень; молодой человек",
    "businesswoman": "деловая женщина; бизнесвумен",
    "cd": "компакт-диск",
    "tv": "телевизор; телевидение",
    "ok": "хорошо; согласен",
    "web site": "веб-сайт; интернет-страница",
    "e.g.": "например",
    "girlfriend": "девушка; подруга",
    "i.e.": "то есть; иначе говоря",
    "makeup": "макияж; грим; состав",
    "online": "онлайн; через интернет",
    "p.m.": "после полудня; время после полудня",
    "photocopy": "ксерокопия; делать копию",
    "software": "программное обеспечение",
    "specifically": "конкретно; специально",
    "cooperation": "сотрудничество; совместная работа",
    "neighborhood": "окрестность; район; соседство",
    "email": "электронная почта; отправлять электронное сообщение",
    "entertainer": "артист-эстрадник; развлекатель",
}

SUFFIX_RULES: List[Tuple[str, str]] = [
    ("ies", "y"),
    ("ied", "y"),
    ("ing", ""),
    ("ed", ""),
    ("ers", "er"),
    ("est", ""),
    ("ness", ""),
    ("ment", ""),
    ("ments", "ment"),
    ("ful", ""),
    ("less", ""),
    ("ly", ""),
    ("s", ""),
]


@dataclass
class DictionaryEntry:
    head: str
    body: str


def _clean_text(text: str) -> str:
    text = re.sub(r"\[[^\]]*\]", "", text)  # remove phonetics
    text = text.replace("_", "")
    text = text.replace("\u200b", "")
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def parse_mueller(path: Path) -> Dict[str, List[DictionaryEntry]]:
    entries: Dict[str, List[DictionaryEntry]] = defaultdict(list)
    current_word: Optional[str] = None
    current_lines: List[str] = []
    with path.open("r", encoding="utf-8", errors="ignore") as fh:
        for raw_line in fh:
            line = raw_line.rstrip("\n")
            if not line:
                continue
            if not line.startswith((" ", "\t")):
                if current_word and current_lines:
                    entries[current_word.lower()].append(
                        DictionaryEntry(current_word, "\n".join(current_lines))
                    )
                current_word = line.strip()
                current_lines = []
            else:
                current_lines.append(line.strip())
    if current_word and current_lines:
            entries[current_word.lower()].append(
            DictionaryEntry(current_word, "\n".join(current_lines))
        )
    return entries


def parse_freedict(path: Path) -> Dict[str, List[DictionaryEntry]]:
    entries: Dict[str, List[DictionaryEntry]] = defaultdict(list)
    with path.open("r", encoding="utf-8", errors="ignore") as fh:
        lines = [line.strip() for line in fh if line.strip()]
    i = 0
    while i < len(lines) - 1:
        head = lines[i]
        if head.startswith("00-database") or head.endswith(":"):
            i += 1
            continue
        if "/" in head:
            word = head.split(" ", 1)[0]
            translation = lines[i + 1]
            if translation.endswith(":"):
                i += 1
                continue
            entries[word.lower()].append(DictionaryEntry(word, translation))
            i += 2
        else:
            i += 1
    return entries


def load_mueller_lines(path: Path) -> List[str]:
    with path.open("r", encoding="utf-8", errors="ignore") as fh:
        return [line.strip() for line in fh if line.strip()]


class OxfordMetadata:
    def __init__(self, html_path: Path) -> None:
        self.html_path = html_path
        self.entries: Dict[str, Dict[str, object]] = defaultdict(dict)
        self._parse()

    def _parse(self) -> None:
        if not self.html_path.exists():
            self.html_path.parent.mkdir(parents=True, exist_ok=True)
            print("Downloading Oxford metadata HTML...")
            urlretrieve(OXFORD_HTML_URL, self.html_path)
        html = self.html_path.read_text(encoding="utf-8", errors="ignore")
        soup = BeautifulSoup(html, "html.parser")
        for item in soup.select("li[data-hw]"):
            word = item["data-hw"].strip()
            entry = self.entries.setdefault(word, {
                "pos": set(),
                "oxford_urls": set(),
                "level": None,
                "audio_uk": None,
                "audio_us": None,
            })
            level = item.get("data-ox3000")
            if level:
                level = level.upper()
                current = entry.get("level")
                if not current or LEVEL_ORDER.get(level, 99) < LEVEL_ORDER.get(current, 99):
                    entry["level"] = level
            pos_node = item.select_one(".pos")
            if pos_node:
                entry["pos"].add(pos_node.get_text(strip=True))
            link = item.find("a")
            if link and link.get("href"):
                entry["oxford_urls"].add(link["href"])
            for pron in item.select(".sound"):
                src = pron.get("data-src-mp3")
                if not src:
                    continue
                if "pron-uk" in pron.get("class", []):
                    entry.setdefault("audio_uk", src)
                elif "pron-us" in pron.get("class", []):
                    entry.setdefault("audio_us", src)

        # convert sets to sorted lists
        for data in self.entries.values():
            data["pos"] = sorted(data["pos"])
            urls = sorted(data["oxford_urls"])
            data["oxford_urls"] = [
                f"https://www.oxfordlearnersdictionaries.com{u}" for u in urls
            ]
            if data.get("audio_uk"):
                data["audio_uk"] = (
                    f"https://www.oxfordlearnersdictionaries.com{data['audio_uk']}"
                )
            if data.get("audio_us"):
                data["audio_us"] = (
                    f"https://www.oxfordlearnersdictionaries.com{data['audio_us']}"
                )

    def get(self, word: str) -> Dict[str, object]:
        return self.entries.get(word, {})


def normalize_phrase(line: str, phrase: str) -> str:
    idx = line.lower().find(phrase)
    if idx == -1:
        return line
    remainder = line[idx + len(phrase) :].strip(" -:;–—")
    return remainder or line


def lookup_translation(
    word: str,
    mueller: Dict[str, List[DictionaryEntry]],
    mueller_lines: List[str],
    freedict: Dict[str, List[DictionaryEntry]],
    visited: Optional[set[str]] = None,
) -> Tuple[str, str]:
    lower = word.lower()
    if visited is None:
        visited = set()
    if lower in visited:
        raise KeyError(f"No translation found for '{word}'")
    visited.add(lower)
    if lower in MANUAL_TRANSLATIONS:
        return MANUAL_TRANSLATIONS[lower], "manual"
    if lower in mueller:
        entry = mueller[lower][0]
        return _clean_text(entry.body), f"mueller:{entry.head}"
    if lower in freedict:
        entry = freedict[lower][0]
        return _clean_text(entry.body), f"freedict:{entry.head}"

    # punctuation variations
    stripped = lower.strip(".;:!,?()")
    if stripped != lower:
        text, src = lookup_translation(stripped, mueller, mueller_lines, freedict, visited)
        if text:
            return text, src

    # numbering (e.g., close 1)
    if " " in lower:
        base = lower.split(" ", 1)[0]
        try_text, source = lookup_translation(base, mueller, mueller_lines, freedict, visited)
        if try_text:
            return try_text, source

    # American -> British mapping
    if lower in AMERICAN_TO_BRITISH:
        try_text, source = lookup_translation(
            AMERICAN_TO_BRITISH[lower], mueller, mueller_lines, freedict, visited
        )
        if try_text:
            return try_text, source

    # hyphen / spacing variations
    if "-" in lower:
        try_text, source = lookup_translation(lower.replace("-", ""), mueller, mueller_lines, freedict, visited)
        if try_text:
            return try_text, source
        try_text, source = lookup_translation(lower.replace("-", " "), mueller, mueller_lines, freedict, visited)
        if try_text:
            return try_text, source
    if " " in lower:
        try_text, source = lookup_translation(lower.replace(" ", ""), mueller, mueller_lines, freedict, visited)
        if try_text:
            return try_text, source

    # suffix stripping
    for suffix, replacement in SUFFIX_RULES:
        if lower.endswith(suffix) and len(lower) > len(suffix) + 2:
            candidate = lower[: -len(suffix)] + replacement
            try_text, source = lookup_translation(candidate, mueller, mueller_lines, freedict, visited)
            if try_text:
                return try_text, source

    # fallback: search entire dictionary lines for phrase (phrasal verbs)
    phrase = lower
    for line in mueller_lines:
        if phrase in line.lower():
            translation = normalize_phrase(line, phrase)
            cleaned = _clean_text(translation)
            if cleaned:
                return cleaned, "mueller:line"

    raise KeyError(f"No translation found for '{word}'")


def build_dataset() -> List[Dict[str, object]]:
    mueller = parse_mueller(MUELLER_DICT_PATH)
    mueller_lines = load_mueller_lines(MUELLER_DICT_PATH)
    freedict = parse_freedict(FREEDICT_PATH)
    metadata = OxfordMetadata(OXFORD_HTML_PATH)

    words = json.loads(OXFORD_LIST_PATH.read_text(encoding="utf-8"))
    dataset: List[Dict[str, object]] = []

    for word in words:
        translation, source = lookup_translation(word, mueller, mueller_lines, freedict)
        meta = metadata.get(word)
        entry = {
            "word": word,
            "translation": translation,
            "source": source,
            "level": meta.get("level"),
            "pos": meta.get("pos", []),
            "oxford_urls": meta.get("oxford_urls", []),
            "audio": {
                "uk": meta.get("audio_uk"),
                "us": meta.get("audio_us"),
            },
        }
        dataset.append(entry)

    return dataset


def main() -> None:
    dataset = build_dataset()
    OUTPUT_PATH.write_text(
        json.dumps(dataset, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"Saved {len(dataset)} cards to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
