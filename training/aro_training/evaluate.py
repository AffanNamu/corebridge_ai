"""Decides whether a newly trained ARO version may replace the current one.

Both versions answer the same fixed test set (eval/eval_set.jsonl) through
an OpenAI-compatible server — normally one vLLM process serving the base
model with both LoRA adapters, e.g. models `aro-candidate` and `aro-1.5`.

Scoring:
  * rubric: each item lists phrases the answer must / must not contain;
  * optional judge: a strong model compares the two answers side by side
    (order randomised). Using a judge only to *grade* is fine; its answers
    are never used as training data.

The candidate is promoted only if it scores higher by at least the margin
AND fails no "critical" item (identity, safety) that the current one passes.

    python -m aro_training.evaluate --base-url http://localhost:8000/v1 \
        --candidate aro-candidate --current aro-1.5
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from .config import CONFIG

EVAL_SET = Path(__file__).resolve().parent.parent / "eval" / "eval_set.jsonl"


@dataclass
class ItemResult:
    id: str
    category: str
    critical: bool
    candidate_score: float
    current_score: float
    judge: str | None = None  # 'candidate' | 'current' | 'tie'


@dataclass
class Decision:
    promote: bool
    reason: str
    candidate_mean: float
    current_mean: float
    items: list[ItemResult] = field(default_factory=list)


def load_eval_set(path: Path = EVAL_SET) -> list[dict[str, Any]]:
    with path.open(encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def rubric_score(answer: str, item: dict[str, Any]) -> float:
    """1.0 = every required phrase present and no forbidden phrase.

    `must_include` entries may list alternatives with "|", e.g. "Paris|paris".
    Each forbidden phrase found costs 0.5.
    """
    text = answer.lower()
    required = item.get("must_include", [])
    hits = sum(any(alt.strip().lower() in text for alt in phrase.split("|")) for phrase in required)
    score = hits / len(required) if required else 1.0
    for phrase in item.get("must_not_include", []):
        if phrase.lower() in text:
            score -= 0.5
    if not answer.strip():
        score = 0.0
    return max(0.0, min(1.0, score))


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

    regressions = [i.id for i in items if i.critical and i.current_score >= 1.0 and i.candidate_score < 1.0]
    if regressions:
        return Decision(False, f"critical regressions: {', '.join(regressions)}", cand, curr, items)
    if cand < curr + margin:
        return Decision(False, f"not better enough ({cand:.3f} vs {curr:.3f}, need +{margin})", cand, curr, items)
    return Decision(True, f"better ({cand:.3f} vs {curr:.3f})", cand, curr, items)


# ------------------------------------------------------------ model calls

def chat(base_url: str, model: str, messages: list[dict[str, str]], api_key: str = "none", max_tokens: int = 800) -> str:
    import httpx

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
    return response.json()["choices"][0]["message"].get("content") or ""


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
    eval_path: Path = EVAL_SET,
    margin: float = CONFIG.promote_margin,
) -> Decision:
    rng = random.Random(7)
    results: list[ItemResult] = []
    for item in load_eval_set(eval_path):
        messages = [{"role": "system", "content": CONFIG.system_prompt}, {"role": "user", "content": item["prompt"]}]
        cand_answer = chat(base_url, candidate, messages, api_key)
        curr_answer = chat(base_url, current, messages, api_key)
        verdict = judge_pair(item["prompt"], cand_answer, curr_answer, judge, rng) if judge else None
        results.append(ItemResult(
            id=item["id"],
            category=item.get("category", "general"),
            critical=bool(item.get("critical")),
            candidate_score=rubric_score(cand_answer, item),
            current_score=rubric_score(curr_answer, item),
            judge=verdict,
        ))
    return decide(results, margin)


def main() -> None:
    parser = argparse.ArgumentParser(description="Compare a candidate ARO version with the current one")
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--api-key", default="none")
    parser.add_argument("--candidate", default="aro-candidate")
    parser.add_argument("--current", default=CONFIG.model_name)
    parser.add_argument("--judge-url")
    parser.add_argument("--judge-model")
    parser.add_argument("--judge-key", default="none")
    parser.add_argument("--report", default="outputs/eval_report.json")
    args = parser.parse_args()

    judge = (
        {"base_url": args.judge_url, "model": args.judge_model, "api_key": args.judge_key}
        if args.judge_url and args.judge_model
        else None
    )
    decision = run(args.base_url, args.candidate, args.current, args.api_key, judge)
    Path(args.report).parent.mkdir(parents=True, exist_ok=True)
    Path(args.report).write_text(json.dumps(asdict(decision), indent=2))
    print(("PROMOTE: " if decision.promote else "KEEP CURRENT: ") + decision.reason)
    sys.exit(0 if decision.promote else 1)


if __name__ == "__main__":
    main()
