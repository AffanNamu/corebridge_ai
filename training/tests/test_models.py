import json
import re
from pathlib import Path

import pytest

from aro_data.registry import LicenseGateError, assert_trainable
from aro_training import compare, prepare, serve, sources
from aro_training.config import CONFIG
from aro_training.evaluate import ItemResult, fold, load_eval_set, record, rubric_score, summarize
from aro_training.export import Conversation, build_examples
from aro_training.models import all_specs, spec, trainable_specs

ROOT = Path(__file__).resolve().parents[2]


def test_four_text_models_share_one_foundation():
    specs = trainable_specs()
    assert [s.id for s in specs] == ["aro-1.5", "aro-code", "aro-research", "aro-translate"]
    assert {s.base_model for s in specs} == {"Qwen/Qwen3-4B"}
    assert not spec("aro-vision").trainable and not spec("aro-voice").trainable and not spec("aro-creative").trainable
    assert len(all_specs()) == 7


def test_aro_1_5_prompt_is_identical_everywhere():
    router = (ROOT / "supabase/functions/_shared/llm/providers.ts").read_text()
    match = re.search(r"ARO_SYSTEM_PROMPT =\s*'([^']*)' \+\s*'([^']*)'", router)
    assert match, "ARO_SYSTEM_PROMPT not found in providers.ts"
    assert match.group(1) + match.group(2) == spec("aro-1.5").system_prompt == CONFIG.system_prompt


def test_every_starter_source_passes_the_license_gate():
    for model in trainable_specs():
        assert model.starter_sources, model.id
        for dataset_id, count in model.starter_sources:
            assert count > 0
            assert_trainable(dataset_id, model.id)
            assert dataset_id in sources.LOADERS


def test_loader_refuses_uncleared_data_before_downloading(monkeypatch):
    monkeypatch.setitem(sources.LOADERS, "no-robots", lambda *_: pytest.fail("must not download"))
    with pytest.raises(LicenseGateError):
        sources.load_source("no-robots", spec("aro-1.5"), 10)
    with pytest.raises(LicenseGateError):
        sources.load_source("smol", spec("aro-code"), 10)  # cleared, but not for ARO Code


def test_convert_gsm8k():
    [ex] = sources.convert_gsm8k([{"question": "Q?", "answer": "48/2 = <<48/2=24>>24\n#### 72"}], spec("aro-research"))
    assert ex["messages"][0]["content"] == spec("aro-research").system_prompt
    assert ex["messages"][-1]["content"] == "48/2 = 24\n\n**Answer: 72**"


def test_convert_code_contests_picks_shortest_python3_solution():
    row = {
        "name": "p1",
        "description": "Print the sum of two numbers.",
        "solutions": str({"language": [2, 3, 3, 1], "solution": ["int main(){}", "a,b=map(int,input().split())\nprint(a+b)", "print(sum(map(int,input().split())))", "print 1"]}),
    }
    [ex] = sources.convert_code_contests([row], spec("aro-code"))
    assert ex["messages"][-1]["content"] == "```python\nprint(sum(map(int,input().split())))\n```"
    assert sources.convert_code_contests([{**row, "solutions": {"language": [2], "solution": ["x"]}}], spec("aro-code")) == []


def test_convert_aya_keeps_priority_languages():
    rows = [
        {"inputs": "Menene sunanka?", "targets": "Sunana Aisha.", "language_code": "hau"},
        {"inputs": "Hola", "targets": "Hola", "language_code": "spa"},
        {"inputs": " ", "targets": "x", "language_code": "yor"},
    ]
    examples = sources.convert_aya(rows, spec("aro-translate"))
    assert [e["messages"][1]["content"] for e in examples] == ["Menene sunanka?"]


def test_convert_smol_makes_translation_requests_both_ways():
    pairs = [{"sl": "en", "tl": "ha", "src": f"Hello {i}", "trg": f"Sannu {i}", "id": str(i)} for i in range(40)]
    examples = sources.convert_smol_pairs(pairs, spec("aro-translate"))
    prompts = [e["messages"][1]["content"] for e in examples]
    assert any("Hausa" in p and "Hello" in p for p in prompts)
    assert any("English" in p and "Sannu" in p for p in prompts)
    for e in examples:
        user, answer = e["messages"][1]["content"], e["messages"][2]["content"]
        assert ("Hello" in user) != ("Hello" in answer)


def test_specialists_learn_their_own_name():
    code_identity = sources.identity_for(spec("aro-code"))
    answers = " ".join(e["messages"][-1]["content"] for e in code_identity)
    assert "ARO Code" in answers and "ARO 1.5" not in answers
    assert "ARO 1.5" in " ".join(e["messages"][-1]["content"] for e in sources.identity_for(spec("aro-1.5")))


def test_feedback_goes_to_the_model_that_answered():
    convo = Conversation(id="c", owner_id="u", messages=[
        {"role": "user", "content": "fix my bug"},
        {"role": "assistant", "content": "fixed", "servedBy": "aro", "model": "aro-code", "rating": 1},
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": "hi", "servedBy": "aro", "rating": 1},  # older message: no model → ARO 1.5
    ])
    code = build_examples([convo], spec("aro-code").system_prompt, model_id="aro-code")
    general = build_examples([convo], spec("aro-1.5").system_prompt, model_id="aro-1.5")
    assert [e["messages"][-1]["content"] for e in code.sft] == ["fixed"]
    assert [e["messages"][-1]["content"] for e in general.sft] == ["hi"]
    assert code.skipped_other_model == 1


def test_prepare_model_end_to_end_offline(tmp_path, monkeypatch):
    model = spec("aro-translate")
    leaked_prompt = load_eval_set(model.eval_set)[1]["prompt"]
    fake = [
        {"messages": [{"role": "system", "content": model.system_prompt}, {"role": "user", "content": f"Translate number {i} please"}, {"role": "assistant", "content": f"Lamba {i}"}], "source": f"smol:en-ha:{i}"}
        for i in range(20)
    ]
    fake.append({"messages": [{"role": "system", "content": model.system_prompt}, {"role": "user", "content": leaked_prompt + " and please explain the usage in detail for me"}, {"role": "assistant", "content": "x"}], "source": "smol:en-ha:leak"})
    monkeypatch.setattr(prepare, "load_source", lambda dataset_id, s, limit: fake if dataset_id == "smol" else [])

    n = prepare.prepare_model(model, None, tmp_path)
    train = [json.loads(line) for line in (tmp_path / "aro-translate" / "train.jsonl").read_text().splitlines()]
    assert n == len(train) > 20 - 1
    assert not any(leaked_prompt in e["messages"][1]["content"] for e in train), "test question leaked into training"
    manifest = json.loads((tmp_path / "aro-translate" / "train.jsonl.manifest.json").read_text())
    assert {s["id"] for s in manifest["sources"]} == {"smol", "aro-identity", "aro-web-grounding"}
    assert manifest["model"] == "aro-translate"
    # Second run with no new feedback: nothing to train.
    assert prepare.prepare_model(model, [], tmp_path) == 0


@pytest.mark.parametrize("model", ["aro-1.5", "aro-code", "aro-research", "aro-translate"])
def test_each_text_model_has_a_wellformed_test_set(model):
    items = load_eval_set(spec(model).eval_set)
    assert len(items) >= 14
    assert len({i["id"] for i in items}) == len(items)
    assert any(i.get("critical") and i["category"] == "identity" for i in items)


def test_rubric_ignores_accents_and_case():
    assert fold("Ẹ ṢÉ") == "e se"
    assert rubric_score("Ẹ ṣé o!", {"must_include": ["e se|e dupe"]}) == 1.0
    assert rubric_score("Jërëjëf", {"must_include": ["jerejef"]}) == 1.0


def test_summary_metrics_for_the_dashboard():
    items = [
        ItemResult("a", "hausa", False, 1.0, 0.0, candidate_latency_s=1.0, current_latency_s=2.0, candidate_tokens=50, current_tokens=40),
        ItemResult("b", "hausa", True, 0.5, 1.0, candidate_latency_s=3.0, current_latency_s=2.0, candidate_tokens=50, current_tokens=40),
    ]
    m = summarize(items)
    assert m["categories"]["hausa"] == {"candidate": 0.75, "current": 0.5, "n": 2}
    assert m["candidate"]["latency_mean_s"] == 2.0 and m["candidate"]["tokens_per_s"] == 25.0
    assert m["candidate"]["critical_failures"] == 1 and m["current"]["critical_failures"] == 0


def test_vllm_command_serves_all_adapters_and_candidates():
    cmd = serve.build_command({"aro-1.5": "/a/15", "aro-code": "/a/code"}, "Qwen/Qwen3-4B", api_key="k",
                              candidates=serve.parse_candidates("aro-translate=/c/tr"))
    joined = " ".join(cmd)
    assert "aro-1.5=/a/15" in joined and "aro-code=/a/code" in joined and "aro-translate-candidate=/c/tr" in joined
    assert "--served-model-name" not in cmd and "--api-key" in cmd and "--enable-auto-tool-choice" in cmd

    fresh = serve.build_command({}, "Qwen/Qwen3-4B", bf16=False)
    assert fresh[fresh.index("--served-model-name") + 1] == "aro-1.5"
    assert "--enable-lora" not in fresh and "half" in fresh


def test_leaderboard_record_and_comparison_table(tmp_path, monkeypatch):
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    from aro_training.evaluate import decide

    decision = decide([ItemResult("a", "x", False, 1.0, 0.5)], margin=0.0)
    decision.model = "aro-code"
    path = tmp_path / "leaderboard.jsonl"
    record(decision, "run-1", path)
    rows = compare.load(path)
    assert rows[0]["model"] == "aro-code" and rows[0]["promote"]
    text = compare.table(rows, "aro-code")
    assert "aro-code" in text and "+0.500" in text and "published" in text
    assert compare.table(rows, "aro-vision") == "No evaluations yet."


def test_translate_trains_for_more_passes():
    assert spec("aro-translate").epochs == 2.0
    assert spec("aro-1.5").epochs == 1.0


def test_vllm_command_caches_prefixes_and_quantizes_only_when_asked():
    cmd = serve.build_command({}, "Qwen/Qwen3-4B")
    assert "--enable-prefix-caching" in cmd and "--quantization" not in cmd
    fp8 = serve.build_command({}, "Qwen/Qwen3-4B", quantization="fp8", kv_cache_dtype="fp8")
    assert fp8[fp8.index("--quantization") + 1] == "fp8" and fp8[fp8.index("--kv-cache-dtype") + 1] == "fp8"


def test_interrupted_training_resumes_from_the_newest_complete_checkpoint(tmp_path):
    from aro_training.train import latest_checkpoint

    assert latest_checkpoint(tmp_path / "missing") is None
    for step, complete in [(100, True), (300, True), (400, False)]:
        d = tmp_path / f"checkpoint-{step}"
        d.mkdir()
        if complete:
            (d / "trainer_state.json").write_text("{}")
    assert latest_checkpoint(tmp_path).name == "checkpoint-300"


def test_evaluation_runs_in_parallel_keeps_order_and_can_compare_two_servers(monkeypatch):
    import threading
    import time as _time

    from aro_training import evaluate

    calls: list[tuple[str, str]] = []
    active, peak = 0, 0
    lock = threading.Lock()

    def fake_chat(base_url, model, messages, api_key="none", max_tokens=800):
        nonlocal active, peak
        with lock:
            active += 1
            peak = max(peak, active)
            calls.append((base_url, model))
        _time.sleep(0.01)
        with lock:
            active -= 1
        return ("I'm ARO 1.5." if model == "cand" else "I am Qwen."), 0.01, 5

    monkeypatch.setattr(evaluate, "chat_timed", fake_chat)
    decision = evaluate.run("http://new/v1", "cand", "curr", model_id="aro-1.5",
                            current_base_url="http://old/v1", concurrency=8)
    ids = [i["id"] for i in load_eval_set(spec("aro-1.5").eval_set)]
    assert [r.id for r in decision.items] == ids
    assert peak > 1, "requests overlap so vLLM can batch them"
    assert {("http://new/v1", "cand"), ("http://old/v1", "curr")} == set(calls)


def test_web_grounded_examples_match_what_the_server_sends():
    import re as _re

    from aro_training.clean import clean
    from aro_training.config import WEB_INSTRUCTIONS, WEB_SEARCH_FAILED
    from aro_training.sources import web_grounded_for

    web_ts = (ROOT / "supabase/functions/_shared/web.ts").read_text()
    m = _re.search(r"export const WEB_INSTRUCTIONS =([^;]+);", web_ts)
    assert m, "WEB_INSTRUCTIONS not found in web.ts"
    pieces = _re.findall(r"'([^']*)'|\"([^\"]*)\"", m.group(1))
    assert "".join(a or b for a, b in pieces) == WEB_INSTRUCTIONS
    router = (ROOT / "supabase/functions/ai-router/handler.ts").read_text()
    assert " ".join(_re.findall(r"'([^']*)'", router[router.index("but the web search failed just now") - 80:][:400]))[:60] in WEB_SEARCH_FAILED

    for model_id in ["aro-1.5", "aro-code", "aro-research"]:
        examples = web_grounded_for(spec(model_id))
        assert len(examples) >= 10
        assert len(clean(examples)) == len(examples), "every web example survives cleaning"
        for e in examples:
            system, answer = e["messages"][0]["content"], e["messages"][-1]["content"]
            assert system.startswith(spec(model_id).system_prompt)
            assert "http" not in answer, "answers cite [n]; the server appends the links"
            if "Search:" in system:
                assert _re.search(r"\[\d\]", answer), answer[:80]
