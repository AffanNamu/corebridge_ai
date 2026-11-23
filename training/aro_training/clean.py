"""Cleans training examples: removes personal data and secrets, drops
duplicates and junk, and mixes in older data so ARO doesn't forget.
"""

from __future__ import annotations

import hashlib
import random
import re
from collections.abc import Iterable
from typing import Any

# Order matters: secrets first (they can contain digits that look like phones).
_REDACTIONS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"), "[PRIVATE_KEY]"),
    (re.compile(r"\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z_-]{35}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b"), "[SECRET]"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b"), "[TOKEN]"),  # JWTs
    (re.compile(r"(?i)\b(password|passwd|pwd|secret|api[_-]?key|token)\s*[:=]\s*\S+"), r"\1: [REDACTED]"),
    (re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"), "[EMAIL]"),
    (re.compile(r"\b(?:\d[ -]?){13,19}\b"), "[CARD_OR_ID]"),
    (re.compile(r"(?<![\w.])\+?\d{1,3}[\s.-]?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}(?![\w.])"), "[PHONE]"),
    (re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b"), "[IP]"),
]

MIN_ANSWER_CHARS = 2
MAX_EXAMPLE_CHARS = 24_000
_ERROR_MARKERS = ("No API key set", "ai-router error", "Model generation failed", "is unreachable")


def scrub(text: str) -> str:
    for pattern, replacement in _REDACTIONS:
        text = pattern.sub(replacement, text)
    return text


def scrub_example(example: dict[str, Any]) -> dict[str, Any]:
    cleaned = dict(example)
    cleaned["messages"] = [
        {**m, "content": m["content"] if m["role"] == "system" else scrub(m["content"])} for m in example["messages"]
    ]
    return cleaned


def _fingerprint(example: dict[str, Any]) -> str:
    convo = [m for m in example["messages"] if m["role"] != "system"]
    norm = "\n".join(f"{m['role']}:{' '.join(m['content'].lower().split())}" for m in convo)
    return hashlib.sha256(norm.encode()).hexdigest()


# Answers where the assistant presents itself as another product. Training on
# them makes ARO forget who it is (seen in the first ARO 1.5 run: 158 of
# 7,992 OpenAssistant replies said "I am OpenAssistant, created by LAION").
_OTHER_IDENTITY = re.compile(
    r"\bopen[- ]?assistant\b|\blaion\b|\bas an ai language model\b"
    r"|\b(?:i am|i'm|my name is|this is)\s+(?:chatgpt|claude|gemini|bard|qwen|llama|mistral)\b"
    r"|\b(?:i was|i am|i'm)\s+(?:created|developed|trained|made|built)\s+by\s+(?:openai|anthropic|google|alibaba|meta|laion)\b",
    re.IGNORECASE,
)


def claims_other_identity(text: str) -> bool:
    return bool(_OTHER_IDENTITY.search(text))


def is_usable(example: dict[str, Any]) -> bool:
    messages = example.get("messages") or []
    if len(messages) < 2 or messages[-1].get("role") != "assistant":
        return False
    answer = str(messages[-1].get("content", "")).strip()
    if len(answer) < MIN_ANSWER_CHARS or any(marker in answer for marker in _ERROR_MARKERS):
        return False
    if example.get("kind") != "identity" and claims_other_identity(answer):
        return False
    return sum(len(str(m.get("content", ""))) for m in messages) <= MAX_EXAMPLE_CHARS


def clean(examples: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Scrub, filter and de-duplicate (first occurrence wins)."""
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for example in examples:
        if not is_usable(example):
            continue
        cleaned = scrub_example(example)
        key = _fingerprint(cleaned)
        if key in seen:
            continue
        seen.add(key)
        out.append(cleaned)
    return out


def mix_with_replay(
    new: list[dict[str, Any]],
    replay_pool: list[dict[str, Any]],
    replay_ratio: float = 0.5,
    seed: int = 0,
) -> list[dict[str, Any]]:
    """Adds older examples so they make up about `replay_ratio` of the set.

    Training only on today's data makes a model forget earlier skills
    ("catastrophic forgetting"); replaying a sample of older data prevents it.
    """
    if not 0 <= replay_ratio < 1:
        raise ValueError("replay_ratio must be in [0, 1)")
    rng = random.Random(seed)
    new_keys = {_fingerprint(e) for e in new}
    pool = [e for e in replay_pool if _fingerprint(e) not in new_keys]
    wanted = round(len(new) * replay_ratio / (1 - replay_ratio)) if new else min(len(pool), 1000)
    mixed = new + rng.sample(pool, min(wanted, len(pool)))
    rng.shuffle(mixed)
    return mixed
