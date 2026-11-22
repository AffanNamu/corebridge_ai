"""ARO Data Engine CLI.

    python -m aro_data validate         # check the registry is complete and consistent
    python -m aro_data license-check    # compare licenses with Hugging Face cards
    python -m aro_data card             # regenerate DATASETS.md
    python -m aro_data sources aro-code # what each model may train / evaluate / retrieve on
"""

from __future__ import annotations

import sys

from . import cards, license_check
from .registry import eval_sources, model_ids, rag_sources, training_sources, validate


def main(argv: list[str]) -> int:
    command = argv[0] if argv else "validate"
    if command == "validate":
        problems = validate()
        print("\n".join(problems) or "Registry OK.")
        return 1 if problems else 0
    if command == "license-check":
        issues = license_check.run()
        print("\n".join(issues) or "All Hugging Face licenses match the registry.")
        return 1 if issues else 0
    if command == "card":
        print(f"Wrote {cards.write()}")
        return 0
    if command == "sources":
        for model in argv[1:] or model_ids():
            print(f"{model}:")
            print("  train:", ", ".join(d.id for d in training_sources(model)) or "—")
            print("  eval: ", ", ".join(d.id for d in eval_sources(model)) or "—")
            print("  rag:  ", ", ".join(d.id for d in rag_sources(model)) or "—")
        return 0
    print(__doc__)
    return 64


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
