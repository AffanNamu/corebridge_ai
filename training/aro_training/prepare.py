"""Builds today's training file: starter data + new user feedback, cleaned,
de-duplicated and mixed with older data so ARO keeps what it learned.

    python -m aro_training.prepare            # starter data (+ users if a key is set)
    python -m aro_training.prepare --no-users # starter data only (first run)

Writes:
    data/train.jsonl     what train.py learns from today
    data/history.jsonl   everything used so far (the replay pool)
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

from .bootstrap import load_identity, load_oasst2
from .clean import clean, mix_with_replay
from .config import CONFIG
from .export import build_examples, read_firestore, write_jsonl


def _read(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    with path.open(encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def build_training_set(
    user_examples: list[dict[str, Any]],
    history: list[dict[str, Any]],
    starter: list[dict[str, Any]],
    identity: list[dict[str, Any]],
    replay_ratio: float = CONFIG.replay_ratio,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Returns (today's training set, updated history)."""
    first_run = not history
    new = clean(user_examples + (starter if first_run else []))
    if not first_run and not new:
        return [], history  # nothing new to learn today
    # Identity examples are always included: they're small and keep ARO from
    # drifting back to the base model's name.
    today = clean(mix_with_replay(new, history, replay_ratio) + identity)
    updated_history = clean(history + new)
    return today, updated_history


def main() -> None:
    parser = argparse.ArgumentParser(description="Prepare today's ARO training data")
    parser.add_argument("--data-dir", default=CONFIG.data_dir)
    parser.add_argument("--no-users", action="store_true", help="Skip the Firestore export")
    parser.add_argument("--since-ms", type=int, default=0)
    parser.add_argument("--starter-limit", type=int, default=6000, help="oasst2 examples on the first run")
    parser.add_argument("--langs", default="en,fr,ha,es,pt,de", help="oasst2 languages to keep")
    args = parser.parse_args()

    data_dir = Path(args.data_dir)
    history = _read(data_dir / "history.jsonl")

    user_examples: list[dict[str, Any]] = []
    if not args.no_users and os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"):
        exported = build_examples(read_firestore(args.since_ms))
        user_examples = exported.sft
        write_jsonl(data_dir / "user_preferences.jsonl", exported.preferences)
        print(f"Users: {len(exported.sft)} examples, {len(exported.preferences)} preference pairs, "
              f"{exported.skipped_unrated} unrated skipped.")
    elif not args.no_users:
        print("GOOGLE_APPLICATION_CREDENTIALS not set — skipping user data.")

    starter = load_oasst2(set(args.langs.split(",")), args.starter_limit) if not history else []
    today, updated_history = build_training_set(user_examples, history, starter, load_identity())

    if not today:
        print("Nothing new to learn today — skipping training.")
        raise SystemExit(2)
    n_today = write_jsonl(data_dir / "train.jsonl", today)
    write_jsonl(data_dir / "history.jsonl", updated_history)
    print(f"Wrote {n_today} training examples ({len(updated_history)} in history).")


if __name__ == "__main__":
    main()
