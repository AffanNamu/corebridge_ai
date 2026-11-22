"""Normalization, quality filters and lightweight language identification.

`identify_language` is a dependency-free heuristic for ARO's priority
languages (script + distinctive letters + common words). It's good enough to
route and filter data; for research-grade language ID plug in GlotLID or
fastText via `set_language_identifier`.
"""

from __future__ import annotations

import re
import unicodedata
from collections import Counter
from collections.abc import Callable

_WS = re.compile(r"[ \t ]+")
_MANY_NEWLINES = re.compile(r"\n{3,}")
_WORD = re.compile(r"[^\W\d_]+(?:['’][^\W\d_]+)?", re.UNICODE)


def normalize(text: str) -> str:
    """Unicode NFC, unified whitespace, no control characters."""
    text = unicodedata.normalize("NFC", text)
    text = "".join(ch for ch in text if ch in "\n\t" or unicodedata.category(ch)[0] != "C")
    text = "\n".join(_WS.sub(" ", line).strip() for line in text.split("\n"))
    return _MANY_NEWLINES.sub("\n\n", text).strip()


def repetition_ratio(text: str) -> float:
    """Share of words that belong to the single most repeated 3-gram run (0 = varied)."""
    words = text.lower().split()
    if len(words) < 12:
        return 0.0
    grams = Counter(tuple(words[i:i + 3]) for i in range(len(words) - 2))
    top = grams.most_common(1)[0][1]
    return min(1.0, top * 3 / len(words))


def passes_quality(text: str, min_chars: int = 2, max_chars: int = 24_000, max_repetition: float = 0.5) -> bool:
    stripped = text.strip()
    if not (min_chars <= len(stripped) <= max_chars):
        return False
    letters = sum(ch.isalpha() for ch in stripped)
    if len(stripped) > 40 and letters / len(stripped) < 0.2 and "```" not in stripped:
        return False  # mostly symbols / mojibake
    return repetition_ratio(stripped) <= max_repetition


# ---------------------------------------------------------- language ID

_SCRIPTS: list[tuple[str, re.Pattern[str]]] = [
    ("am", re.compile(r"[ሀ-፿]")),  # Ethiopic (Amharic)
    ("ar", re.compile(r"[؀-ۿ]")),  # Arabic
]

# Common words that are distinctive for each Latin-script language.
_WORDS: dict[str, set[str]] = {
    "en": {"the", "and", "is", "are", "of", "to", "in", "that", "it", "you", "for", "with", "this", "was", "what", "how"},
    "ha": {"da", "na", "ba", "ya", "ta", "wannan", "ina", "shi", "ita", "kuma", "su", "mun", "akwai", "yana", "tana", "zan", "kai", "sannu", "ne", "ce", "domin", "amma"},
    "yo": {"ni", "ti", "si", "won", "o", "mo", "fun", "pe", "ati", "naa", "kan", "je", "lati", "awon", "àwọn", "ẹ", "ọ", "jẹ́", "ń", "kò"},
    "ig": {"na", "nke", "bụ", "ya", "ndị", "ọ", "m", "anyị", "ha", "ka", "maka", "gị", "dị", "nwere", "otu", "ebe", "kedu"},
    "pcm": {"dey", "wey", "una", "dem", "abeg", "wetin", "na", "don", "go", "sabi", "pikin", "make", "comot", "oga", "dis", "di"},
    "sw": {"na", "ya", "wa", "kwa", "ni", "katika", "hii", "ili", "kuwa", "lakini", "sana", "habari", "mimi", "wewe", "yeye", "sisi"},
    "zu": {"ukuthi", "futhi", "kodwa", "ngoba", "kanye", "ngi", "uma", "lokho", "abantu", "sawubona", "kakhulu", "yini"},
    "xh": {"ukuba", "kwaye", "kodwa", "ngoko", "abantu", "molo", "kakhulu", "nje", "into", "yonke", "ndiyabulela"},
    "wo": {"ak", "ci", "la", "ngi", "dafa", "dama", "nanga", "def", "jërëjëf", "lu", "yi", "bi", "mu", "dañu", "waaye"},
    "ff": {"e", "ko", "mi", "nde", "ɗum", "kadi", "ngam", "jam", "ɓe", "ina", "won", "maa", "hono", "noon"},
    "fr": {"le", "la", "les", "et", "est", "un", "une", "des", "que", "pour", "dans", "pas", "vous", "je", "bonjour", "merci"},
}

# Letters that strongly suggest a language.
_LETTERS: dict[str, str] = {
    "ha": "ɓɗƙƴ",
    "yo": "ẹọṣ",
    "ig": "ịụṅ",
    "wo": "ëñ",
    "ff": "ŋ",
}

LanguageIdentifier = Callable[[str], str]
_custom: LanguageIdentifier | None = None


def set_language_identifier(identifier: LanguageIdentifier | None) -> None:
    """Swap in a stronger model (e.g. GlotLID) for `identify_language`."""
    global _custom
    _custom = identifier


def identify_language(text: str) -> str:
    """Best-guess ISO 639 code for ARO's priority languages, or 'und'."""
    if _custom is not None:
        return _custom(text)
    for code, pattern in _SCRIPTS:
        if len(pattern.findall(text)) >= max(3, len(text) * 0.2):
            return code
    lowered = unicodedata.normalize("NFC", text.lower())
    words = _WORD.findall(lowered)
    if not words:
        return "und"
    scores: dict[str, float] = {}
    for code, vocab in _WORDS.items():
        scores[code] = sum(1 for w in words if w in vocab) / len(words)
    for code, letters in _LETTERS.items():
        hits = sum(lowered.count(ch) for ch in letters)
        if hits:
            scores[code] = scores.get(code, 0.0) + min(0.5, hits / max(1, len(words)) * 2)
    best, score = max(scores.items(), key=lambda item: item[1])
    return best if score >= 0.08 else "und"
