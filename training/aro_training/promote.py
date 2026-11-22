"""Publishes an accepted ARO adapter to a private Hugging Face repo.

Layout of the Hub repo (ARO_HUB_REPO, e.g. "your-org/aro-1.5"):
    versions/<version>/   adapter files + aro_manifest.json
    current.json          {"version": "<version>", "history": [...]}

The model server loads versions/<current>/ (see scripts/serve_vllm.sh).
Rolling back just points current.json at an earlier version.

    python -m aro_training.promote publish outputs/run-.../adapter --report outputs/eval_report.json
    python -m aro_training.promote rollback
"""

from __future__ import annotations

import argparse
import json
import tempfile
import time
from pathlib import Path
from typing import Any

from .config import CONFIG

CURRENT_FILE = "current.json"


def next_pointer(pointer: dict[str, Any] | None, version: str, note: str = "") -> dict[str, Any]:
    pointer = dict(pointer or {})
    history = list(pointer.get("history", []))
    history.append({"version": version, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "note": note})
    return {"version": version, "history": history[-50:]}


def rollback_pointer(pointer: dict[str, Any]) -> dict[str, Any]:
    history = list(pointer.get("history", []))
    versions = [h["version"] for h in history]
    current = pointer.get("version")
    earlier = [v for v in versions if v != current]
    if not earlier:
        raise SystemExit("No earlier version to roll back to.")
    target = earlier[-1]
    return next_pointer(pointer, target, note=f"rollback from {current}")


def _api():
    from huggingface_hub import HfApi

    return HfApi()


def _read_pointer(repo: str) -> dict[str, Any] | None:
    from huggingface_hub import hf_hub_download
    from huggingface_hub.utils import EntryNotFoundError

    try:
        return json.loads(Path(hf_hub_download(repo, CURRENT_FILE)).read_text())
    except EntryNotFoundError:
        return None


def _write_pointer(repo: str, pointer: dict[str, Any], message: str) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / CURRENT_FILE
        path.write_text(json.dumps(pointer, indent=2))
        _api().upload_file(path_or_fileobj=str(path), path_in_repo=CURRENT_FILE, repo_id=repo, commit_message=message)


def publish(adapter_dir: str, report: str | None, repo: str = CONFIG.hub_repo) -> str:
    if not repo:
        raise SystemExit("Set ARO_HUB_REPO (e.g. your-org/aro-1.5) to publish.")
    if report:
        decision = json.loads(Path(report).read_text())
        if not decision.get("promote"):
            raise SystemExit(f"Refusing to publish: evaluation said keep current ({decision.get('reason')}).")

    version = time.strftime("v%Y%m%d-%H%M", time.gmtime())
    api = _api()
    api.create_repo(repo, private=True, exist_ok=True)
    api.upload_folder(folder_path=adapter_dir, path_in_repo=f"versions/{version}", repo_id=repo,
                      commit_message=f"Add ARO version {version}")
    _write_pointer(repo, next_pointer(_read_pointer(repo), version), f"Promote {version}")
    print(f"Published {version} to {repo}. Restart the model server to serve it.")
    return version


def rollback(repo: str = CONFIG.hub_repo) -> str:
    pointer = _read_pointer(repo)
    if not pointer:
        raise SystemExit("Nothing published yet.")
    updated = rollback_pointer(pointer)
    _write_pointer(repo, updated, f"Roll back to {updated['version']}")
    print(f"Rolled back to {updated['version']}. Restart the model server to serve it.")
    return updated["version"]


def main() -> None:
    parser = argparse.ArgumentParser(description="Publish or roll back ARO versions on the Hugging Face Hub")
    sub = parser.add_subparsers(dest="command", required=True)
    pub = sub.add_parser("publish")
    pub.add_argument("adapter_dir")
    pub.add_argument("--report", help="eval_report.json from aro_training.evaluate (required to pass)")
    sub.add_parser("rollback")
    args = parser.parse_args()
    if args.command == "publish":
        publish(args.adapter_dir, args.report)
    else:
        rollback()


if __name__ == "__main__":
    main()
