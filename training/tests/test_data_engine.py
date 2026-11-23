import json

import pytest

from aro_data import cards, contamination, license_check, manifest, quality, registry
from aro_data.registry import LicenseGateError


def test_registry_is_valid_and_complete():
    assert registry.validate() == []
    ids = {d.id for d in registry.load_registry()}
    # Every resource named in the seven-model brief is tracked.
    for required in [
        "fineweb", "dolma", "oasst1", "tulu3-sft", "ultrachat-200k", "no-robots", "wikimedia-dumps",
        "the-stack", "starcoderdata", "codesearchnet", "commitpack", "mbpp", "humaneval", "swe-bench", "code-contests",
        "gsm8k", "competition-math", "numinamath-cot", "open-web-math", "ai2-arc", "big-bench", "arxiv", "openalex",
        "semantic-scholar", "pubmed", "uci-ml", "coco", "open-images", "visual-genome", "imagenet", "wikimedia-commons",
        "ego4d", "activitynet", "common-voice", "librispeech", "libritts", "fleurs", "waxal", "gigaspeech", "musan",
        "voxpopuli", "audioset", "laion", "conceptual-captions", "webvid", "youcook2", "open-x-embodiment",
        "afrolm", "african-storybook", "smol", "aya",
    ]:
        assert required in ids, required


def test_every_catalog_model_is_known():
    catalog = json.loads(registry.CATALOG_PATH.read_text())
    assert [m["id"] for m in catalog["models"]] == [
        "aro-1.5", "aro-code", "aro-research", "aro-vision", "aro-voice", "aro-creative", "aro-translate",
    ]


@pytest.mark.parametrize("dataset_id", ["no-robots", "mafand", "imagenet", "ultrachat-200k", "tulu3-sft", "numinamath-cot", "competition-math", "laion", "webvid", "waxal"])
def test_license_gate_blocks_uncleared_datasets(dataset_id):
    model = registry.get(dataset_id).models[0]
    with pytest.raises(LicenseGateError):
        registry.assert_trainable(dataset_id, model)


@pytest.mark.parametrize("dataset_id", ["mbpp", "humaneval", "swe-bench", "flores-plus", "belebele", "ai2-arc", "afrixnli"])
def test_benchmarks_never_enter_training(dataset_id):
    dataset = registry.get(dataset_id)
    assert dataset.commercial_status == "eval_only"
    for model in registry.model_ids():
        assert dataset not in registry.training_sources(model)


def test_license_gate_allows_cleared_datasets_for_their_models_only():
    assert registry.assert_trainable("smol", "aro-translate").id == "smol"
    assert registry.assert_trainable("oasst2", "aro-1.5").id == "oasst2"
    with pytest.raises(LicenseGateError):
        registry.assert_trainable("smol", "aro-code")  # not assigned
    with pytest.raises(KeyError):
        registry.assert_trainable("made-up-dataset", "aro-1.5")


def test_validator_catches_bad_entries(tmp_path):
    bad = {"datasets": [
        {**registry.get("oasst2").raw, "id": "x1", "commercial_status": "excluded"},          # excluded but train
        {**registry.get("mbpp").raw, "id": "x2", "usage": ["eval", "train"]},                   # eval_only with train
        {**registry.get("gsm8k").raw, "id": "x3", "splits": {"train": "test", "eval": "test"}},  # same split
        {**registry.get("oasst2").raw, "id": "x4", "license_checked": None},                    # no license check
        {**registry.get("oasst2").raw, "id": "x5", "models": ["aro-9000"]},                      # unknown model
    ]}
    path = tmp_path / "r.json"
    path.write_text(json.dumps(bad))
    problems = "\n".join(registry.validate(path))
    for ident in ["x1", "x2", "x3", "x4", "x5"]:
        assert ident in problems, ident


def test_license_check_flags_changes_without_network():
    cards_by_id = {
        "OpenAssistant/oasst2": {"license": ["cc-by-nc-4.0"], "gated": False, "disabled": False},
        "hendrycks/competition_math": {"license": ["mit"], "disabled": True},
    }
    oasst2 = registry.get("oasst2")
    assert license_check.compare(oasst2, cards_by_id["OpenAssistant/oasst2"])  # license changed → flagged
    assert license_check.compare(oasst2, {"license": ["apache-2.0"], "gated": False}) == []
    assert license_check.compare(registry.get("competition-math"), cards_by_id["hendrycks/competition_math"]) == []
    assert license_check.compare(registry.get("smol"), {"error": "HTTP 404"})  # cleared dataset vanished → flagged


def test_language_identification_for_priority_languages():
    samples = {
        "en": "The weather is nice today and I want to go to the market with you.",
        "ha": "Ina kwana? Yaya aiki? Wannan littafin yana da kyau sosai, kuma ina so in karanta shi.",
        "yo": "Ẹ kú àárọ̀. Mo fẹ́ lọ sí ọjà láti ra oúnjẹ fún àwọn ọmọ mi.",
        "ig": "Kedu ka ị mere? Anyị na-aga ahịa taa maka ịzụta nri.",
        "pcm": "Abeg wetin dey happen for dis place? Una don chop?",
        "sw": "Habari yako? Mimi ni mwalimu na ninapenda sana kufundisha watoto katika shule hii.",
        "am": "ሰላም እንዴት ነህ? ዛሬ ወደ ገበያ እሄዳለሁ።",
        "ar": "مرحبا، كيف حالك اليوم؟ أنا ذاهب إلى السوق.",
        "fr": "Bonjour, je suis content de vous voir. Merci pour votre aide dans la maison.",
    }
    for code, text in samples.items():
        assert quality.identify_language(text) == code, (code, quality.identify_language(text))
    assert quality.identify_language("12345 !!!") == "und"


def test_custom_language_identifier_can_be_plugged_in():
    quality.set_language_identifier(lambda text: "zz")
    try:
        assert quality.identify_language("anything") == "zz"
    finally:
        quality.set_language_identifier(None)


def test_normalize_and_quality_filters():
    assert quality.normalize("á  b\t\tc\x00\n\n\n\nd") == "á b c\n\nd"
    assert quality.passes_quality("A clear, useful sentence.")
    assert not quality.passes_quality("buy now " * 50)
    assert not quality.passes_quality("@@##$$%%^^&&**(()){{}}[[]]" * 3)
    assert quality.passes_quality("```python\nprint(1)\n```")


def test_contamination_detects_leaked_eval_questions():
    question = "Natalia sold clips to 48 of her friends in April and then she sold half as many clips in May"
    train = [
        {"messages": [{"role": "user", "content": question + " — how many in total?"}, {"role": "assistant", "content": "72"}]},
        {"messages": [{"role": "user", "content": "What is the capital of Kenya?"}, {"role": "assistant", "content": "Nairobi"}]},
    ]
    clean, removed = contamination.decontaminate(train, [question])
    assert removed == 1 and len(clean) == 1
    assert clean[0]["messages"][1]["content"] == "Nairobi"


def test_manifest_records_provenance_and_detects_changes(tmp_path):
    data = tmp_path / "train.jsonl"
    data.write_text('{"messages": []}\n{"messages": []}\n')
    out = manifest.write_manifest(data, "aro-translate", "train", {"smol": 1, "aya": 1})
    m = json.loads(out.read_text())
    assert m["rows"] == 2 and m["model"] == "aro-translate"
    assert {s["id"] for s in m["sources"]} == {"smol", "aya"}
    assert all(s["license"] for s in m["sources"])
    assert manifest.verify_manifest(out) == []
    data.write_text('{"messages": []}\n')
    assert manifest.verify_manifest(out)


def test_dataset_card_is_generated_for_every_model():
    text = cards.render()
    for name in ["ARO 1.5", "ARO 1.5 · Code", "ARO 1.5 · Research", "Vision", "Voice", "Creative", "ARO 1.5 · Translate"]:
        assert f"## {name}" in text
    assert "❌ excluded" in text and "✅ allowed" in text
