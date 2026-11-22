"""Provenance for every training/eval file: which datasets (and which exact
versions) it came from, its checksum and row count. A training run is
reproducible when its manifest's checksums match the files used.
"""

from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path
from typing import Any

from .registry import get


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def count_rows(path: Path) -> int:
    with path.open(encoding="utf-8") as f:
        return sum(1 for line in f if line.strip())


def write_manifest(
    data_file: Path,
    model_id: str,
    purpose: str,
    sources: dict[str, int],
    revisions: dict[str, str] | None = None,
) -> Path:
    """Writes <data_file>.manifest.json. `sources` maps dataset id → rows used."""
    if purpose not in {"train", "eval"}:
        raise ValueError("purpose must be 'train' or 'eval'")
    entries = []
    for dataset_id, rows in sorted(sources.items()):
        dataset = get(dataset_id)
        entries.append({
            "id": dataset_id,
            "rows": rows,
            "license": dataset.license,
            "commercial_status": dataset.commercial_status,
            "version": (revisions or {}).get(dataset_id, dataset.version),
            "source_url": dataset.source_url,
            "attribution": dataset.attribution,
        })
    manifest: dict[str, Any] = {
        "file": data_file.name,
        "model": model_id,
        "purpose": purpose,
        "sha256": sha256_file(data_file),
        "rows": count_rows(data_file),
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "sources": entries,
    }
    out = data_file.with_suffix(data_file.suffix + ".manifest.json")
    out.write_text(json.dumps(manifest, indent=2, ensure_ascii=False))
    return out


def verify_manifest(manifest_path: Path) -> list[str]:
    """Problems with a manifest (empty = file unchanged and sources still cleared)."""
    manifest = json.loads(manifest_path.read_text())
    data_file = manifest_path.with_name(manifest["file"])
    problems = []
    if not data_file.exists():
        return [f"{data_file} is missing"]
    if sha256_file(data_file) != manifest["sha256"]:
        problems.append(f"{data_file.name} changed since the manifest was written")
    if manifest["purpose"] == "train":
        for source in manifest["sources"]:
            if not get(source["id"]).trainable:
                problems.append(f"{source['id']} is no longer cleared for training")
    return problems
