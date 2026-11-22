"""Turns registry datasets into chat examples for a given ARO model.

Every loader first calls `assert_trainable`, so a dataset that isn't
cleared for commercial training can never reach the training file, even by
mistake. The `convert_*` functions are pure (testable without downloads).
"""

from __future__ import annotations

import ast
import random
import re
from collections.abc import Callable, Iterable
from typing import Any

from aro_data.registry import assert_trainable, get

from .bootstrap import build_oasst_threads, load_identity
from .models import ModelSpec

LANG_NAMES = {
    "en": "English", "ha": "Hausa", "yo": "Yoruba", "ig": "Igbo", "pcm": "Nigerian Pidgin", "ff": "Fulfulde",
    "fuc": "Pulaar", "ar": "Arabic", "sw": "Swahili", "am": "Amharic", "wo": "Wolof", "zu": "Zulu", "xh": "Xhosa",
    "fr": "French",
}
TRANSLATE_LANGS = ["ha", "yo", "ig", "pcm", "ff", "sw", "am", "wo", "zu", "xh"]
AYA_LANGS = {"hau", "ibo", "yor", "swa", "amh", "wol", "xho", "zul", "eng", "fra", "arb"}

_PROMPTS_TO = [
    "Translate into {tl}:\n\n{text}",
    "How do you say this in {tl}?\n\n{text}",
    "Please translate the following {sl} text to {tl}:\n{text}",
    "{text}\n\nTranslate to {tl}.",
]


def _example(spec: ModelSpec, user: str, assistant: str, source: str, kind: str) -> dict[str, Any]:
    return {
        "messages": [
            {"role": "system", "content": spec.system_prompt},
            {"role": "user", "content": user.strip()},
            {"role": "assistant", "content": assistant.strip()},
        ],
        "source": source,
        "kind": kind,
    }


# ---------------------------------------------------------------- converters

def convert_gsm8k(rows: Iterable[dict[str, Any]], spec: ModelSpec) -> list[dict[str, Any]]:
    out = []
    for i, row in enumerate(rows):
        answer = re.sub(r"<<[^>]*>>", "", row["answer"])  # drop calculator annotations
        work, _, final = answer.rpartition("####")
        text = f"{work.strip()}\n\n**Answer: {final.strip()}**" if final.strip() else answer.strip()
        out.append(_example(spec, row["question"], text, f"gsm8k:{i}", "gsm8k"))
    return out


_PY3 = 3  # CodeContests language enum: 1 = Python 2, 2 = C++, 3 = Python 3, 4 = Java


def convert_code_contests(rows: Iterable[dict[str, Any]], spec: ModelSpec, max_chars: int = 3000) -> list[dict[str, Any]]:
    out = []
    for row in rows:
        solutions = row.get("solutions") or {}
        if isinstance(solutions, str):
            solutions = ast.literal_eval(solutions)
        candidates = [
            code for lang, code in zip(solutions.get("language", []), solutions.get("solution", []))
            if lang == _PY3 and len(code) <= max_chars
        ]
        description = (row.get("description") or "").strip()
        if not candidates or not description or len(description) > 6000:
            continue
        code = min(candidates, key=len).strip()
        user = f"Solve this programming problem in Python 3. Read from standard input and write to standard output.\n\n{description}"
        assistant = f"```python\n{code}\n```"
        out.append(_example(spec, user, assistant, f"code-contests:{row.get('name', len(out))}", "code-contests"))
    return out


def convert_aya(rows: Iterable[dict[str, Any]], spec: ModelSpec, langs: set[str] = AYA_LANGS) -> list[dict[str, Any]]:
    out = []
    for i, row in enumerate(rows):
        if row.get("language_code") not in langs:
            continue
        if not row.get("inputs", "").strip() or not row.get("targets", "").strip():
            continue
        out.append(_example(spec, row["inputs"], row["targets"], f"aya:{i}", f"aya:{row['language_code']}"))
    return out


def convert_smol_pairs(pairs: Iterable[dict[str, Any]], spec: ModelSpec, seed: int = 0) -> list[dict[str, Any]]:
    """SMOL sentence pairs → translation requests in both directions."""
    rng = random.Random(seed)
    out = []
    for i, row in enumerate(pairs):
        src, trg = (row.get("src") or "").strip(), (row.get("trg") or "").strip()
        sl, tl = row.get("sl", "en"), row.get("tl", "")
        if not src or not trg or tl not in LANG_NAMES:
            continue
        if rng.random() < 0.5:
            text, answer, from_lang, to_lang = src, trg, sl, tl
        else:
            text, answer, from_lang, to_lang = trg, src, tl, sl
        prompt = rng.choice(_PROMPTS_TO).format(text=text, sl=LANG_NAMES.get(from_lang, from_lang), tl=LANG_NAMES.get(to_lang, to_lang))
        out.append(_example(spec, prompt, answer, f"smol:{sl}-{tl}:{row.get('id', i)}", f"smol:{tl}"))
    return out


def identity_for(spec: ModelSpec) -> list[dict[str, Any]]:
    """The identity seed, rewritten so each specialist knows its own name."""
    examples = load_identity(spec.system_prompt)
    if spec.id == "aro-1.5":
        return examples
    for example in examples:
        answer = example["messages"][-1]
        answer["content"] = answer["content"].replace("ARO 1.5", spec.name)
    return examples


# ------------------------------------------------------------------ loaders

def _hf(dataset_id: str, split: str, config: str | None = None):
    from datasets import load_dataset

    dataset = get(dataset_id)
    revision = dataset.version if re.fullmatch(r"[0-9a-f]{7,40}", dataset.version or "") else None
    return load_dataset(dataset.hf_id, config, split=split, revision=revision)


def _train_split(dataset_id: str) -> str:
    return (get(dataset_id).raw.get("splits") or {}).get("train", "train")


def _load_oasst2(spec: ModelSpec, limit: int) -> list[dict[str, Any]]:
    rows = _hf("oasst2", _train_split("oasst2"))
    return build_oasst_threads(rows, spec.system_prompt, langs={"en", "fr", "es", "pt", "de"})[:limit]


def _load_gsm8k(spec: ModelSpec, limit: int) -> list[dict[str, Any]]:
    return convert_gsm8k(_hf("gsm8k", _train_split("gsm8k"), "main"), spec)[:limit]


def _load_code_contests(spec: ModelSpec, limit: int) -> list[dict[str, Any]]:
    return convert_code_contests(_hf("code-contests", _train_split("code-contests")), spec)[:limit]


def _load_aya(spec: ModelSpec, limit: int) -> list[dict[str, Any]]:
    return convert_aya(_hf("aya", "train"), spec)[:limit]


def _load_smol(spec: ModelSpec, limit: int) -> list[dict[str, Any]]:
    per_lang = max(1, limit // len(TRANSLATE_LANGS))
    examples: list[dict[str, Any]] = []
    for lang in TRANSLATE_LANGS:
        try:
            rows = _hf("smol", "train", f"smolsent__en_{lang}")
        except Exception as err:  # a language may be missing from a release
            print(f"SMOL en→{lang} unavailable: {err}")
            continue
        examples += convert_smol_pairs(list(rows)[:per_lang], spec, seed=hash(lang) & 0xFFFF)
    return examples[:limit]


LOADERS: dict[str, Callable[[ModelSpec, int], list[dict[str, Any]]]] = {
    "oasst2": _load_oasst2,
    "gsm8k": _load_gsm8k,
    "code-contests": _load_code_contests,
    "aya": _load_aya,
    "smol": _load_smol,
}


def load_source(dataset_id: str, spec: ModelSpec, limit: int) -> list[dict[str, Any]]:
    assert_trainable(dataset_id, spec.id)  # license gate — raises if not cleared
    if dataset_id not in LOADERS:
        raise KeyError(f"No converter for {dataset_id} yet.")
    return LOADERS[dataset_id](spec, limit)
