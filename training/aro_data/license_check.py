"""Re-checks registry licenses against Hugging Face's dataset cards.

    python -m aro_data license-check

Reports datasets whose hub license tag no longer matches the registry, that
became gated/disabled, or that can't be read. It never upgrades a status:
a human updates registry/datasets.json after reading the change.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any

from .registry import Dataset, load_registry


def fetch_card(hf_id: str, timeout: float = 30) -> dict[str, Any]:
    request = urllib.request.Request(f"https://huggingface.co/api/datasets/{hf_id}", headers={"User-Agent": "aro-data-engine"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            data = json.load(response)
    except urllib.error.HTTPError as err:
        return {"error": f"HTTP {err.code}"}
    except OSError as err:
        return {"error": str(err)}
    card = data.get("cardData") or {}
    license_tag = card.get("license") or [t[8:] for t in data.get("tags", []) if t.startswith("license:")]
    if isinstance(license_tag, str):
        license_tag = [license_tag]
    return {"license": [str(x).lower() for x in license_tag], "gated": data.get("gated"), "disabled": data.get("disabled"), "sha": data.get("sha")}


def compare(dataset: Dataset, card: dict[str, Any]) -> list[str]:
    issues = []
    if "error" in card:
        if dataset.commercial_status not in {"unverified", "excluded"}:
            issues.append(f"{dataset.id}: card unreadable ({card['error']})")
        return issues
    if card.get("disabled") and dataset.commercial_status != "excluded":
        issues.append(f"{dataset.id}: disabled on the hub — should be 'excluded'")
    registered = dataset.license.lower()
    tags = card.get("license") or []
    if tags and not any(tag in registered for tag in tags):
        issues.append(f"{dataset.id}: hub license {tags} vs registry '{dataset.license}'")
    if card.get("gated") and dataset.commercial_status == "allowed" and "gated" not in dataset.notes.lower():
        issues.append(f"{dataset.id}: now gated — read the new access terms")
    return issues


def run(fetch=fetch_card) -> list[str]:
    issues: list[str] = []
    for dataset in load_registry():
        if dataset.hf_id:
            issues.extend(compare(dataset, fetch(dataset.hf_id)))
    return issues
