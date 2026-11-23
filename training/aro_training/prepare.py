"""Builds today's training file for each ARO text model: starter data on
the first run + new user feedback for that model, cleaned, de-duplicated,
checked against the model's test set, and mixed with older data so the
model keeps what it learned.

    python -m aro_training.prepare                    # every trainable model
    python -m aro_training.prepare --model aro-code   # one model
    python -m aro_training.prepare --no-users         # starter data only

Writes, per model, data/<model>/:
    train.jsonl (+ .manifest.json)   today's training set and its provenance
    history.jsonl                    everything used so far (the replay pool)
"""

from __future__ import annotations

import argparse
import json
import os
import random
from collections import Counter
from pathlib import Path
from typing import Any

from aro_data.contamination import decontaminate
from aro_data.manifest import write_manifest

from .clean import clean, mix_with_replay
from .config import CONFIG
from .export import Conversation, build_examples, read_firestore, write_jsonl
from .models import ModelSpec, spec, trainable_specs
from .sources import identity_for, load_source, web_grounded_for

EXIT_NOTHING_NEW = 2
IDENTITY_REPEAT = 8


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
    # Identity examples are always included, repeated so a few dozen lines
    # still outweigh thousands of general examples: they keep the model from
    # drifting back to another assistant's name.
    today = clean(mix_with_replay(new, history, replay_ratio)) + clean(identity) * IDENTITY_REPEAT
    random.Random(0).shuffle(today)
    updated_history = clean(history + new)
    return today, updated_history


def eval_texts(model: ModelSpec) -> list[str]:
    """Prompts of the model's fixed test set — must never be trained on."""
    if not model.eval_set.exists():
        return []
    with model.eval_set.open(encoding="utf-8") as f:
        return [json.loads(line)["prompt"] for line in f if line.strip()]


_REGISTRY_IDS = {"identity": "aro-identity", "feedback": "aro-user-feedback", "oasst2": "oasst2", "web-grounded": "aro-web-grounding"}


def source_counts(examples: list[dict[str, Any]]) -> dict[str, int]:
    """Rows per registry dataset, for the provenance manifest."""
    counts: Counter[str] = Counter()
    for example in examples:
        prefix = str(example.get("source", "unknown")).split(":")[0]
        counts[_REGISTRY_IDS.get(prefix, prefix)] += 1
    return dict(counts)


def prepare_model(
    model: ModelSpec,
    conversations: list[Conversation] | None,
    data_root: Path,
    starter_scale: float = 1.0,
) -> int:
    """Prepares one model. Returns the number of training examples (0 = nothing new)."""
    data_dir = model.data_dir(data_root)
    history = _read(data_dir / "history.jsonl")

    user_examples: list[dict[str, Any]] = []
    if conversations is not None:
        exported = build_examples(conversations, model.system_prompt, model_id=model.served_name)
        user_examples = exported.sft
        write_jsonl(data_dir / "user_preferences.jsonl", exported.preferences)
        print(f"[{model.id}] users: {len(exported.sft)} examples, {len(exported.preferences)} preference pairs, "
              f"{exported.skipped_unrated} unrated skipped.")

    starter: list[dict[str, Any]] = []
    if not history:
        for dataset_id, count in model.starter_sources:
            starter += load_source(dataset_id, model, max(1, int(count * starter_scale)))

    # Always-included teaching examples: who ARO is, and how to answer from web results.
    taught = identity_for(model) + web_grounded_for(model)
    today, updated_history = build_training_set(user_examples, history, starter, taught)
    today, leaked = decontaminate(today, eval_texts(model))
    if leaked:
        print(f"[{model.id}] removed {leaked} examples that overlapped the test set.")
    if not today:
        print(f"[{model.id}] nothing new to learn today — skipping.")
        return 0

    train_file = data_dir / "train.jsonl"
    n = write_jsonl(train_file, today)
    write_jsonl(data_dir / "history.jsonl", updated_history)
    write_manifest(train_file, model.id, "train", source_counts(today))
    print(f"[{model.id}] wrote {n} training examples ({len(updated_history)} in history).")
    return n


def main() -> None:
    parser = argparse.ArgumentParser(description="Prepare today's ARO training data")
    parser.add_argument("--model", default="all", help="aro-1.5, aro-code, aro-research, aro-translate or all")
    parser.add_argument("--data-dir", default=CONFIG.data_dir)
    parser.add_argument("--no-users", action="store_true", help="Skip the Firestore export")
    parser.add_argument("--since-ms", type=int, default=0)
    parser.add_argument("--starter-scale", type=float, default=1.0, help="Scale starter data (e.g. 0.2 for a quick test)")
    args = parser.parse_args()

    models = trainable_specs() if args.model == "all" else [spec(args.model)]
    if any(not m.trainable for m in models):
        raise SystemExit("Only shared-foundation text models are trained by this pipeline.")

    conversations: list[Conversation] | None = None
    if not args.no_users and os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"):
        conversations = list(read_firestore(args.since_ms))  # read once, split per model
    elif not args.no_users:
        print("GOOGLE_APPLICATION_CREDENTIALS not set — skipping user data.")

    produced = {m.id: prepare_model(m, conversations, Path(args.data_dir), args.starter_scale) for m in models}
    Path(args.data_dir).mkdir(parents=True, exist_ok=True)
    (Path(args.data_dir) / "prepared.json").write_text(json.dumps(produced, indent=2))
    if not any(produced.values()):
        raise SystemExit(EXIT_NOTHING_NEW)


if __name__ == "__main__":
    main()
