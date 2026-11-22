"""Keeps evaluation data out of training data.

If test questions leak into training, scores look better than the model
really is. `find_contaminated` flags training examples that share a long
word n-gram with any evaluation text.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from typing import Any

_TOKEN = re.compile(r"\w+", re.UNICODE)


def _ngrams(text: str, n: int) -> set[tuple[str, ...]]:
    tokens = _TOKEN.findall(text.lower())
    if len(tokens) < n:
        return {tuple(tokens)} if len(tokens) >= max(4, n // 2) else set()
    return {tuple(tokens[i:i + n]) for i in range(len(tokens) - n + 1)}


def example_text(example: dict[str, Any]) -> str:
    if "messages" in example:
        return "\n".join(str(m.get("content", "")) for m in example["messages"] if m.get("role") != "system")
    return " ".join(str(v) for v in example.values() if isinstance(v, str))


def build_index(eval_texts: Iterable[str], n: int = 13) -> set[tuple[str, ...]]:
    index: set[tuple[str, ...]] = set()
    for text in eval_texts:
        index |= _ngrams(text, n)
    return index


def find_contaminated(train: list[dict[str, Any]], eval_texts: Iterable[str], n: int = 13) -> list[int]:
    """Indices of training examples that overlap evaluation text."""
    index = build_index(eval_texts, n)
    if not index:
        return []
    return [i for i, example in enumerate(train) if _ngrams(example_text(example), n) & index]


def decontaminate(train: list[dict[str, Any]], eval_texts: Iterable[str], n: int = 13) -> tuple[list[dict[str, Any]], int]:
    bad = set(find_contaminated(train, eval_texts, n))
    return [e for i, e in enumerate(train) if i not in bad], len(bad)
