"""Per-model training specs, read from models/catalog.json.

ARO 1.5, Code, Research and Translate are LoRA adapters on the shared
foundation, so this pipeline trains them. Vision, Voice and Creative use
specialist models with their own training stacks (see docs/MODELS.md).
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CATALOG_PATH = ROOT / "models" / "catalog.json"
EVAL_DIR = Path(__file__).resolve().parent.parent / "eval"


@dataclass(frozen=True)
class ModelSpec:
    id: str
    name: str
    served_name: str
    base_model: str
    system_prompt: str
    trainable: bool
    thinking_default: bool
    # (dataset id, how many examples on a first run) — every id passes the license gate.
    starter_sources: tuple[tuple[str, int], ...]
    # Passes over the training data. Translation needs more than one: a single
    # pass left ARO Translate no better than the base model.
    epochs: float = 1.0

    @property
    def eval_set(self) -> Path:
        return EVAL_DIR / f"{self.id}.jsonl"

    def data_dir(self, root: str | Path = "data") -> Path:
        return Path(root) / self.id

    def hub_repo(self) -> str:
        """Private Hugging Face repo for this model's versions."""
        if self.id == "aro-1.5" and os.environ.get("ARO_HUB_REPO"):
            return os.environ["ARO_HUB_REPO"]  # backwards compatible with the ARO 1.5 setup
        namespace = os.environ.get("ARO_HUB_NAMESPACE", "")
        return f"{namespace}/{self.id}" if namespace else ""


# Starter data per model. Mixed with user feedback after the first run.
_STARTERS: dict[str, tuple[tuple[str, int], ...]] = {
    "aro-1.5": (("oasst2", 6000), ("aya", 1500), ("gsm8k", 500)),
    "aro-code": (("code-contests", 3000), ("oasst2", 1500)),
    "aro-research": (("gsm8k", 5000), ("code-contests", 500)),
    "aro-translate": (("smol", 8000), ("aya", 3000)),
}


_EPOCHS: dict[str, float] = {"aro-translate": 2.0}


@lru_cache(maxsize=1)
def _catalog() -> dict:
    return json.loads(CATALOG_PATH.read_text(encoding="utf-8"))


def all_specs() -> dict[str, ModelSpec]:
    catalog = _catalog()
    specs = {}
    for m in catalog["models"]:
        arch = m["architecture"]
        specs[m["id"]] = ModelSpec(
            id=m["id"],
            name=m["name"],
            served_name=arch.get("served_name", m["id"]),
            base_model=arch.get("base_model") or catalog["shared_foundation"]["base_model"],
            system_prompt=m.get("system_prompt", ""),
            trainable=arch["strategy"] == "shared-foundation-lora",
            thinking_default=bool(arch.get("thinking_default")),
            starter_sources=_STARTERS.get(m["id"], ()),
            epochs=_EPOCHS.get(m["id"], 1.0),
        )
    return specs


def spec(model_id: str) -> ModelSpec:
    specs = all_specs()
    if model_id not in specs:
        raise SystemExit(f"Unknown model {model_id!r}. Choose one of: {', '.join(specs)}")
    return specs[model_id]


def trainable_specs() -> list[ModelSpec]:
    return [s for s in all_specs().values() if s.trainable]
