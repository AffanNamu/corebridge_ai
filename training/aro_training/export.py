"""Builds training examples from ARO AI's Firestore data.

What is used (and nothing else):
  * only users with `trainingConsent == true` (Settings → Help improve ARO);
  * only replies that ARO itself produced (`servedBy == "aro"`) — answers
    from Claude, ChatGPT, Gemini or Qwen, or from the backup model, are
    never used, because their terms forbid training a competing model on
    their outputs;
  * 👍 replies become supervised examples ("sft");
  * 👎 replies with a user correction become an sft example using the
    correction, plus a preference pair (chosen = correction, rejected =
    ARO's answer) for later preference training;
  * unrated replies are skipped — training a model on its own unchecked
    answers makes it worse over time.

User ids are never written out; examples carry a one-way hash instead.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .config import CONFIG

MAX_CONTEXT_MESSAGES = 12


@dataclass
class Conversation:
    id: str
    owner_id: str
    messages: list[dict[str, Any]] = field(default_factory=list)  # ordered by createdAt


@dataclass
class ExportResult:
    sft: list[dict[str, Any]] = field(default_factory=list)
    preferences: list[dict[str, Any]] = field(default_factory=list)
    skipped_unrated: int = 0
    skipped_not_aro: int = 0


def _hash(*parts: str) -> str:
    return hashlib.sha256("\x1f".join(parts).encode()).hexdigest()[:16]


def _context(messages: list[dict[str, Any]], upto: int, system_prompt: str) -> list[dict[str, str]]:
    """Chat history before message `upto`, trimmed to the last few turns."""
    history = [
        {"role": m["role"], "content": str(m.get("content", ""))}
        for m in messages[:upto]
        if m.get("role") in ("user", "assistant") and str(m.get("content", "")).strip()
    ][-MAX_CONTEXT_MESSAGES:]
    # Must start with a user turn.
    while history and history[0]["role"] != "user":
        history.pop(0)
    return [{"role": "system", "content": system_prompt}, *history]


def build_examples(conversations: Iterable[Conversation], system_prompt: str = CONFIG.system_prompt) -> ExportResult:
    result = ExportResult()
    for convo in conversations:
        for index, message in enumerate(convo.messages):
            if message.get("role") != "assistant":
                continue
            if message.get("servedBy") != "aro":
                result.skipped_not_aro += 1
                continue

            rating = int(message.get("rating") or 0)
            correction = str(message.get("correction") or "").strip()
            answer = str(message.get("content", "")).strip()
            prompt = _context(convo.messages, index, system_prompt)
            if len(prompt) < 2 or prompt[-1]["role"] != "user":
                continue

            source = _hash(convo.owner_id, convo.id, str(message.get("id", index)))
            if rating > 0 and answer:
                result.sft.append({"messages": [*prompt, {"role": "assistant", "content": answer}], "source": source, "kind": "liked"})
            elif rating < 0 and correction:
                result.sft.append(
                    {"messages": [*prompt, {"role": "assistant", "content": correction}], "source": source, "kind": "corrected"}
                )
                if answer:
                    result.preferences.append({"prompt": prompt, "chosen": correction, "rejected": answer, "source": source})
            else:
                result.skipped_unrated += 1
    return result


def read_firestore(since_ms: int = 0) -> Iterator[Conversation]:
    """Yields conversations of consenting users from Firestore (Admin SDK).

    Needs a service-account key: set GOOGLE_APPLICATION_CREDENTIALS to its
    path. Never commit that file.
    """
    import firebase_admin
    from firebase_admin import firestore

    if not firebase_admin._apps:
        firebase_admin.initialize_app()
    db = firestore.client()

    for user in db.collection("users").where("trainingConsent", "==", True).stream():
        query = db.collection("conversations").where("ownerId", "==", user.id)
        if since_ms:
            query = query.where("updatedAt", ">", since_ms)
        for convo in query.stream():
            items = convo.reference.collection("items").order_by("createdAt").stream()
            messages = [{"id": item.id, **item.to_dict()} for item in items]
            yield Conversation(id=convo.id, owner_id=user.id, messages=messages)


def write_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with path.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
            count += 1
    return count


def main() -> None:
    parser = argparse.ArgumentParser(description="Export consented, rated ARO chats from Firestore")
    parser.add_argument("--since-ms", type=int, default=0, help="Only conversations updated after this time")
    parser.add_argument("--out", default=CONFIG.data_dir)
    args = parser.parse_args()

    result = build_examples(read_firestore(args.since_ms))
    out = Path(args.out)
    n_sft = write_jsonl(out / "user_sft.jsonl", result.sft)
    n_pref = write_jsonl(out / "user_preferences.jsonl", result.preferences)
    print(
        f"Exported {n_sft} training examples and {n_pref} preference pairs "
        f"(skipped {result.skipped_unrated} unrated ARO replies, {result.skipped_not_aro} non-ARO replies)."
    )


if __name__ == "__main__":
    main()
