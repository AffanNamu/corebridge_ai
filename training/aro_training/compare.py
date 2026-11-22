"""Model comparison: every evaluation, per model, newest first.

    python -m aro_training.compare              # all models
    python -m aro_training.compare aro-code     # one model

Reads results/leaderboard.jsonl (written by aro_training.evaluate). The
same rows appear in the admin dashboard when Supabase keys are set.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from .evaluate import LEADERBOARD


def load(path: Path = LEADERBOARD) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    with path.open(encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def table(rows: list[dict[str, Any]], model: str | None = None) -> str:
    rows = [r for r in rows if model in (None, r["model"])]
    if not rows:
        return "No evaluations yet."
    lines = ["| Model | Run | When | Candidate | Current | Δ | Latency (s) | Tokens/s | Critical fails | Result |",
             "|---|---|---|---|---|---|---|---|---|---|"]
    for r in sorted(rows, key=lambda r: (r["model"], r["at"]), reverse=True):
        cand = r.get("metrics", {}).get("candidate", {})
        delta = r["candidate_score"] - r["current_score"]
        lines.append(
            f"| {r['model']} | {r['candidate']} | {r['at'][:16]} | {r['candidate_score']:.3f} | {r['current_score']:.3f} "
            f"| {delta:+.3f} | {cand.get('latency_mean_s', 0):.2f} | {cand.get('tokens_per_s', 0):.0f} "
            f"| {cand.get('critical_failures', 0)} | {'✅ published' if r['promote'] else '— kept current'} |"
        )
    return "\n".join(lines)


if __name__ == "__main__":
    print(table(load(), sys.argv[1] if len(sys.argv) > 1 else None))
