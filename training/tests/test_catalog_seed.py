import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _gen():
    spec = importlib.util.spec_from_file_location("gen_seed", ROOT / "models" / "gen_seed.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_seed_migration_matches_catalog_and_plans():
    gen = _gen()
    assert gen.OUT.read_text(encoding="utf-8") == gen.render(), "Run: python models/gen_seed.py"


def test_plans_only_reference_catalog_models():
    catalog = {m["id"] for m in json.loads((ROOT / "models" / "catalog.json").read_text())["models"]}
    plans = json.loads((ROOT / "models" / "plans.json").read_text())
    assert set(plans["credit_costs"]) == catalog
    for plan in plans["plans"]:
        assert set(plan["models"]) <= catalog, plan["id"]
    for product in plans["model_products"]:
        assert product["model_id"] in catalog
    assert [p["id"] for p in plans["plans"]] == ["free", "pro", "premium"]
