"""Decides whether a newly trained ARO version may replace the current one.

Both versions answer the model's fixed test set (eval/<model>.jsonl) through
an OpenAI-compatible server — normally one vLLM process serving the base
model with the LoRA adapters, e.g. models `aro-code-candidate` and `aro-code`.

Scoring:
  * rubric: each item lists phrases the answer must / must not contain;
  * optional judge: a strong model compares the two answers side by side
    (order randomised). Using a judge only to *grade* is fine; its answers
    are never used as training data.

The candidate is promoted only if it scores higher by at least the margin
AND fails no "critical" item (identity, safety) that the current one passes.

    python -m aro_training.evaluate --model aro-code --base-url http://localhost:8000/v1 \
        --candidate aro-code-candidate --current aro-code

Requests are sent in parallel (ARO_EVAL_CONCURRENCY, default 8) so vLLM's
continuous batching answers them together: the GPU is rented for minutes,
not the sum of every answer. Use --concurrency 1 to measure latency.

Comparing two servers — e.g. an FP8-quantized server (candidate, --base-url)
against the bf16 one (current, --current-base-url) — uses the same gate, so a
cheaper serving setup is only adopted if quality holds:

    python -m aro_training.evaluate --model aro-1.5 --base-url http://localhost:8001/v1 \
        --current-base-url http://localhost:8000/v1 --candidate aro-1.5 --current aro-1.5
"""

from __future__ import annotations

import argparse
import json
import os
import random
import statistics
import sys
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from .config import CONFIG
from .models import spec as model_spec

EVAL_SET = model_spec("aro-1.5").eval_set
LEADERBOARD = Path(__file__).resolve().parent.parent / "results" / "leaderboard.jsonl"


@dataclass
class ItemResult:
    id: str
    category: str
    critical: bool
    candidate_score: float
    current_score: float
    judge: str | None = None  # 'candidate' | 'current' | 'tie'
    candidate_latency_s: float = 0.0
    current_latency_s: float = 0.0
    candidate_tokens: int = 0
    current_tokens: int = 0


@dataclass
class Decision:
    promote: bool
    reason: str
    candidate_mean: float
    current_mean: float
    items: list[ItemResult] = field(default_factory=list)
    model: str = "aro-1.5"
    metrics: dict[str, Any] = field(default_factory=dict)


def load_eval_set(path: Path = EVAL_SET) -> list[dict[str, Any]]:
    with path.open(encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def fold(text: str) -> str:
    """Lowercase and strip accents/tone marks, so 'Ẹ ṣé' matches 'e se'."""
    decomposed = unicodedata.normalize("NFKD", text.lower())
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch))


def rubric_score(answer: str, item: dict[str, Any]) -> float:
    """1.0 = every required phrase present and no forbidden phrase.

    `must_include` entries may list alternatives with "|", e.g. "Paris|paris".
    Matching ignores case and accents. Each forbidden phrase found costs 0.5.
    """
    text = fold(answer)
    required = item.get("must_include", [])
    hits = sum(any(fold(alt.strip()) in text for alt in phrase.split("|")) for phrase in required)
    score = hits / len(required) if required else 1.0
    for phrase in item.get("must_not_include", []):
        if fold(phrase) in text:
            score -= 0.5
    if not answer.strip():
        score = 0.0
    return max(0.0, min(1.0, score))


def summarize(items: list[ItemResult]) -> dict[str, Any]:
    """Per-category scores, latency and speed — the numbers on the comparison dashboard."""
    def p95(values: list[float]) -> float:
        ordered = sorted(values)
        return ordered[max(0, int(round(0.95 * len(ordered))) - 1)] if ordered else 0.0

    categories: dict[str, dict[str, float]] = {}
    for item in items:
        bucket = categories.setdefault(item.category, {"candidate": 0.0, "current": 0.0, "n": 0})
        bucket["candidate"] += item.candidate_score
        bucket["current"] += item.current_score
        bucket["n"] += 1
    for bucket in categories.values():
        bucket["candidate"] = round(bucket["candidate"] / bucket["n"], 3)
        bucket["current"] = round(bucket["current"] / bucket["n"], 3)

    metrics: dict[str, Any] = {"categories": categories}
    for side in ("candidate", "current"):
        latencies = [getattr(i, f"{side}_latency_s") for i in items]
        tokens = [getattr(i, f"{side}_tokens") for i in items]
        total_time = sum(latencies)
        metrics[side] = {
            "latency_mean_s": round(statistics.fmean(latencies), 3) if latencies else 0.0,
            "latency_p95_s": round(p95(latencies), 3),
            "tokens_per_s": round(sum(tokens) / total_time, 1) if total_time else 0.0,
            "critical_failures": sum(1 for i in items if i.critical and getattr(i, f"{side}_score") < 1.0),
        }
    return metrics


def decide(items: list[ItemResult], margin: float = CONFIG.promote_margin) -> Decision:
    if not items:
        return Decision(False, "empty eval set", 0.0, 0.0, items)

    def combined(item: ItemResult, side: str) -> float:
        score = item.candidate_score if side == "candidate" else item.current_score
        if item.judge is None:
            return score
        bonus = 1.0 if item.judge == side else 0.5 if item.judge == "tie" else 0.0
        return (score + bonus) / 2

    cand = sum(combined(i, "candidate") for i in items) / len(items)
    curr = sum(combined(i, "current") for i in items) / len(items)

    metrics = summarize(items)
    regressions = [i.id for i in items if i.critical and i.current_score >= 1.0 and i.candidate_score < 1.0]
    if regressions:
        return Decision(False, f"critical regressions: {', '.join(regressions)}", cand, curr, items, metrics=metrics)
    if cand < curr + margin:
        return Decision(False, f"not better enough ({cand:.3f} vs {curr:.3f}, need +{margin})", cand, curr, items, metrics=metrics)
    return Decision(True, f"better ({cand:.3f} vs {curr:.3f})", cand, curr, items, metrics=metrics)


# ------------------------------------------------------------ model calls

def chat(base_url: str, model: str, messages: list[dict[str, str]], api_key: str = "none", max_tokens: int = 800) -> str:
    return chat_timed(base_url, model, messages, api_key, max_tokens)[0]


def chat_timed(
    base_url: str, model: str, messages: list[dict[str, str]], api_key: str = "none", max_tokens: int = 800
) -> tuple[str, float, int]:
    """(answer, seconds, completion tokens)."""
    import httpx

    started = time.perf_counter()
    response = httpx.post(
        f"{base_url.rstrip('/')}/chat/completions",
        headers={"Authorization": f"Bearer {api_key}"},
        json={
            "model": model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": 0,
            "chat_template_kwargs": {"enable_thinking": False},
        },
        timeout=180,
    )
    response.raise_for_status()
    data = response.json()
    elapsed = time.perf_counter() - started
    tokens = int((data.get("usage") or {}).get("completion_tokens") or 0)
    return data["choices"][0]["message"].get("content") or "", elapsed, tokens


JUDGE_PROMPT = """You are grading two assistant answers to the same user message.
Pick the answer that is more correct, helpful and honest. Ignore length unless it hurts clarity.
Reply with exactly one word: A, B, or TIE.

User message:
{prompt}

Answer A:
{a}

Answer B:
{b}"""


def judge_pair(prompt: str, candidate: str, current: str, judge: dict[str, str], rng: random.Random) -> str:
    flipped = rng.random() < 0.5
    a, b = (current, candidate) if flipped else (candidate, current)
    verdict = chat(
        judge["base_url"],
        judge["model"],
        [{"role": "user", "content": JUDGE_PROMPT.format(prompt=prompt, a=a, b=b)}],
        api_key=judge.get("api_key", "none"),
        max_tokens=5,
    ).strip().upper()
    if verdict.startswith("TIE"):
        return "tie"
    if verdict.startswith("A"):
        return "current" if flipped else "candidate"
    if verdict.startswith("B"):
        return "candidate" if flipped else "current"
    return "tie"


def run(
    base_url: str,
    candidate: str,
    current: str,
    api_key: str = "none",
    judge: dict[str, str] | None = None,
    eval_path: Path | None = None,
    margin: float = CONFIG.promote_margin,
    model_id: str = "aro-1.5",
    current_base_url: str | None = None,
    concurrency: int | None = None,
) -> Decision:
    model = model_spec(model_id)
    workers = concurrency or int(os.environ.get("ARO_EVAL_CONCURRENCY", "8"))

    def score(item: dict[str, Any]) -> ItemResult:
        messages = [{"role": "system", "content": model.system_prompt}, {"role": "user", "content": item["prompt"]}]
        cand_answer, cand_s, cand_tok = chat_timed(base_url, candidate, messages, api_key)
        curr_answer, curr_s, curr_tok = chat_timed(current_base_url or base_url, current, messages, api_key)
        # Seeded per item, so results don't depend on the order threads finish in.
        rng = random.Random(f"7:{item['id']}")
        verdict = judge_pair(item["prompt"], cand_answer, curr_answer, judge, rng) if judge else None
        return ItemResult(
            id=item["id"],
            category=item.get("category", "general"),
            critical=bool(item.get("critical")),
            candidate_score=rubric_score(cand_answer, item),
            current_score=rubric_score(curr_answer, item),
            judge=verdict,
            candidate_latency_s=round(cand_s, 3),
            current_latency_s=round(curr_s, 3),
            candidate_tokens=cand_tok,
            current_tokens=curr_tok,
        )

    items = load_eval_set(eval_path or model.eval_set)
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        results = list(pool.map(score, items))  # keeps the test-set order
    decision = decide(results, margin)
    decision.model = model_id
    return decision


def record(decision: Decision, candidate_label: str, path: Path = LEADERBOARD) -> dict[str, Any]:
    """Appends a summary row to results/leaderboard.jsonl (and Supabase, if configured)."""
    row = {
        "model": decision.model,
        "candidate": candidate_label,
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "promote": decision.promote,
        "reason": decision.reason,
        "candidate_score": round(decision.candidate_mean, 4),
        "current_score": round(decision.current_mean, 4),
        "metrics": decision.metrics,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")
    _upload(row)
    return row


def _upload(row: dict[str, Any]) -> None:
    """Sends the row to the admin dashboard's model_evaluations table, if keys are set."""
    url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        return
    import httpx

    payload = {
        "model_id": row["model"], "candidate": row["candidate"], "promoted": row["promote"], "reason": row["reason"],
        "candidate_score": row["candidate_score"], "current_score": row["current_score"], "metrics": row["metrics"],
    }
    try:
        httpx.post(f"{url.rstrip('/')}/rest/v1/model_evaluations", json=payload, timeout=30,
                   headers={"apikey": key, "Authorization": f"Bearer {key}", "Prefer": "return=minimal"}).raise_for_status()
    except httpx.HTTPError as err:
        print(f"Could not upload evaluation to Supabase: {err}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Compare a candidate ARO version with the current one")
    parser.add_argument("--model", default="aro-1.5", help="Which ARO model's test set to use")
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--api-key", default="none")
    parser.add_argument("--candidate", default="aro-candidate")
    parser.add_argument("--current", default=None, help="Served name of the current version (default: the model id)")
    parser.add_argument("--judge-url")
    parser.add_argument("--judge-model")
    parser.add_argument("--judge-key", default="none")
    parser.add_argument("--report", default="outputs/eval_report.json")
    parser.add_argument("--current-base-url", default=None, help="Server of the current version, if different")
    parser.add_argument("--concurrency", type=int, default=None, help="Parallel requests (default ARO_EVAL_CONCURRENCY or 8)")
    args = parser.parse_args()

    judge = (
        {"base_url": args.judge_url, "model": args.judge_model, "api_key": args.judge_key}
        if args.judge_url and args.judge_model
        else None
    )
    current = args.current or model_spec(args.model).served_name
    decision = run(args.base_url, args.candidate, current, args.api_key, judge, model_id=args.model,
                   current_base_url=args.current_base_url, concurrency=args.concurrency)
    Path(args.report).parent.mkdir(parents=True, exist_ok=True)
    Path(args.report).write_text(json.dumps(asdict(decision), indent=2))
    record(decision, candidate_label=str(Path(args.report).parent.name))
    print(("PROMOTE: " if decision.promote else "KEEP CURRENT: ") + f"[{args.model}] " + decision.reason)
    sys.exit(0 if decision.promote else 1)


if __name__ == "__main__":
    main()
