"""The dataset registry and the license gate.

Every dataset ARO may touch is listed in registry/datasets.json. Training
code never loads a dataset directly: it asks `assert_trainable(id, model)`,
which refuses anything not cleared for commercial training.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

REGISTRY_PATH = Path(__file__).resolve().parent / "registry" / "datasets.json"
CATALOG_PATH = Path(__file__).resolve().parents[2] / "models" / "catalog.json"

STATUSES = {"allowed", "conditional", "eval_only", "rag_only", "restricted", "excluded", "unverified"}
USAGES = {"train", "train-after-review", "pretrain", "eval", "rag", "augment"}
REQUIRED_FIELDS = (
    "id", "name", "publisher", "source_url", "version", "download_method", "size", "format", "languages",
    "license", "license_checked", "commercial_status", "usage", "redistribution", "attribution", "quality",
    "models", "notes",
)


class LicenseGateError(PermissionError):
    """Raised when code tries to train on a dataset that isn't cleared."""


@dataclass(frozen=True)
class Dataset:
    raw: dict[str, Any]

    def __getattr__(self, name: str) -> Any:
        try:
            return self.raw[name]
        except KeyError as exc:  # pragma: no cover - attribute typo
            raise AttributeError(name) from exc

    @property
    def trainable(self) -> bool:
        return (
            self.raw["commercial_status"] == "allowed"
            and "train" in self.raw["usage"]
            and bool(self.raw.get("license_checked"))
        )


@lru_cache(maxsize=4)
def _load(path: str) -> tuple[Dataset, ...]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return tuple(Dataset(entry) for entry in data["datasets"])


def load_registry(path: Path = REGISTRY_PATH) -> list[Dataset]:
    return list(_load(str(path)))


def get(dataset_id: str, path: Path = REGISTRY_PATH) -> Dataset:
    for dataset in load_registry(path):
        if dataset.id == dataset_id:
            return dataset
    raise KeyError(f"Dataset {dataset_id!r} is not in the registry — add it (with its license) first.")


def model_ids(catalog_path: Path = CATALOG_PATH) -> list[str]:
    return [m["id"] for m in json.loads(catalog_path.read_text(encoding="utf-8"))["models"]]


def assert_trainable(dataset_id: str, model_id: str, path: Path = REGISTRY_PATH) -> Dataset:
    dataset = get(dataset_id, path)
    if not dataset.trainable:
        raise LicenseGateError(
            f"{dataset_id} can't be used for training: status '{dataset.commercial_status}', "
            f"usage {dataset.usage}. {dataset.notes}"
        )
    if model_id not in dataset.models:
        raise LicenseGateError(f"{dataset_id} is not assigned to {model_id} in the registry.")
    return dataset


def training_sources(model_id: str, path: Path = REGISTRY_PATH) -> list[Dataset]:
    return [d for d in load_registry(path) if d.trainable and model_id in d.models]


def eval_sources(model_id: str, path: Path = REGISTRY_PATH) -> list[Dataset]:
    return [d for d in load_registry(path) if "eval" in d.usage and model_id in d.models]


def rag_sources(model_id: str, path: Path = REGISTRY_PATH) -> list[Dataset]:
    return [d for d in load_registry(path) if "rag" in d.usage and model_id in d.models]


def validate(path: Path = REGISTRY_PATH, catalog_path: Path = CATALOG_PATH) -> list[str]:
    """Returns every problem found in the registry (empty list = valid)."""
    problems: list[str] = []
    known_models = set(model_ids(catalog_path))
    seen: set[str] = set()
    for d in load_registry(path):
        entry = d.raw
        ident = entry.get("id", "<missing id>")
        for field in REQUIRED_FIELDS:
            if field not in entry:
                problems.append(f"{ident}: missing field '{field}'")
        if ident in seen:
            problems.append(f"{ident}: duplicate id")
        seen.add(ident)
        status = entry.get("commercial_status")
        usage = set(entry.get("usage", []))
        if status not in STATUSES:
            problems.append(f"{ident}: unknown commercial_status {status!r}")
        if not usage <= USAGES:
            problems.append(f"{ident}: unknown usage {sorted(usage - USAGES)}")
        if unknown := set(entry.get("models", [])) - known_models:
            problems.append(f"{ident}: unknown models {sorted(unknown)}")
        if "train" in usage and status != "allowed":
            problems.append(f"{ident}: 'train' usage requires commercial_status 'allowed' (is {status!r})")
        if "train" in usage and not entry.get("license_checked"):
            problems.append(f"{ident}: 'train' usage requires a recorded license check")
        if status in {"excluded", "restricted", "unverified"} and usage & {"train", "train-after-review", "pretrain"}:
            problems.append(f"{ident}: {status} datasets can't have training usage")
        if status == "eval_only" and usage != {"eval"}:
            problems.append(f"{ident}: eval_only datasets may only have 'eval' usage")
        if status == "rag_only" and usage != {"rag"}:
            problems.append(f"{ident}: rag_only datasets may only have 'rag' usage")
        splits = entry.get("splits") or {}
        if "train" in usage and "eval" in usage and not splits:
            problems.append(f"{ident}: used for both train and eval — declare separate splits")
        if splits and splits.get("train") == splits.get("eval"):
            problems.append(f"{ident}: train and eval splits must differ")
    return problems
