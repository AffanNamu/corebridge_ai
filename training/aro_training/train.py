"""Fine-tunes ARO with QLoRA (Unsloth + TRL). Needs an NVIDIA GPU.

Free Colab T4 (16 GB) is enough for Qwen3-4B in 4-bit. The result is a
small LoRA adapter (~100 MB) that vLLM serves on top of the base model.

    python -m aro_training.train --model aro-code     # data/aro-code/train.jsonl → outputs/aro-code/run-…
"""

from __future__ import annotations

import argparse
import inspect
import json
import time
from pathlib import Path
from typing import Any

from .config import CONFIG, Config
from .models import spec as model_spec


def load_jsonl(path: str | Path) -> list[dict[str, Any]]:
    with Path(path).open(encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def to_text(tokenizer: Any, example: dict[str, Any]) -> str:
    """Renders one chat example with the base model's chat template."""
    try:
        # Qwen3: train the direct-answer mode (no <think> block).
        return tokenizer.apply_chat_template(
            example["messages"], tokenize=False, add_generation_prompt=False, enable_thinking=False
        )
    except TypeError:
        return tokenizer.apply_chat_template(example["messages"], tokenize=False, add_generation_prompt=False)


def _filter_kwargs(cls: Any, kwargs: dict[str, Any]) -> dict[str, Any]:
    """TRL renames arguments between versions; pass only the ones it knows."""
    accepted = set(inspect.signature(cls.__init__).parameters)
    return {k: v for k, v in kwargs.items() if k in accepted}


def train(
    data_path: str,
    out_dir: str,
    cfg: Config = CONFIG,
    init_adapter: str | None = None,
    model_id: str = "aro-1.5",
) -> Path:
    # Imported here so the rest of the package works without a GPU.
    from unsloth import FastLanguageModel  # noqa: I001  (must be imported before transformers)
    from unsloth.chat_templates import train_on_responses_only
    from datasets import Dataset
    from trl import SFTConfig, SFTTrainer

    examples = load_jsonl(data_path)
    if not examples:
        raise SystemExit(f"No training examples in {data_path}")
    aro_model = model_spec(model_id)
    if not aro_model.trainable:
        raise SystemExit(f"{aro_model.name} isn't a shared-foundation text model; it has its own training stack.")

    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=init_adapter or aro_model.base_model,
        max_seq_length=cfg.max_seq_length,
        load_in_4bit=True,
    )
    if init_adapter is None:
        model = FastLanguageModel.get_peft_model(
            model,
            r=cfg.lora_rank,
            lora_alpha=cfg.lora_rank * 2,
            lora_dropout=0,
            target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
            use_gradient_checkpointing="unsloth",
            random_state=3407,
        )

    dataset = Dataset.from_list([{"text": to_text(tokenizer, e)} for e in examples])

    args = SFTConfig(**_filter_kwargs(SFTConfig, {
        "output_dir": str(Path(out_dir) / "checkpoints"),
        "dataset_text_field": "text",
        "max_seq_length": cfg.max_seq_length,
        "max_length": cfg.max_seq_length,
        "per_device_train_batch_size": cfg.batch_size,
        "gradient_accumulation_steps": cfg.grad_accum,
        "num_train_epochs": cfg.epochs,
        "learning_rate": cfg.learning_rate,
        "lr_scheduler_type": "cosine",
        "warmup_ratio": 0.03,
        "weight_decay": 0.01,
        "logging_steps": 10,
        "save_strategy": "no",
        "optim": "adamw_8bit",
        "seed": 3407,
        "report_to": "none",
    }))
    trainer = SFTTrainer(**_filter_kwargs(SFTTrainer, {
        "model": model,
        "tokenizer": tokenizer,
        "processing_class": tokenizer,
        "train_dataset": dataset,
        "args": args,
    }))
    # Learn only from the assistant's answers, not from the user's prompts.
    trainer = train_on_responses_only(
        trainer,
        instruction_part="<|im_start|>user\n",
        response_part="<|im_start|>assistant\n",
    )

    started = time.time()
    stats = trainer.train()

    adapter_dir = Path(out_dir) / "adapter"
    model.save_pretrained(str(adapter_dir))
    tokenizer.save_pretrained(str(adapter_dir))
    manifest = {
        "model_id": aro_model.id,
        "model_name": aro_model.served_name,
        "base_model": aro_model.base_model,
        "examples": len(examples),
        "train_loss": getattr(stats, "training_loss", None),
        "minutes": round((time.time() - started) / 60, 1),
        "lora_rank": cfg.lora_rank,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    (adapter_dir / "aro_manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"Saved adapter to {adapter_dir}: {manifest}")
    return adapter_dir


def main() -> None:
    parser = argparse.ArgumentParser(description="Fine-tune an ARO text model with QLoRA")
    parser.add_argument("--model", default="aro-1.5", help="aro-1.5, aro-code, aro-research or aro-translate")
    parser.add_argument("--data", default=None, help="Default: data/<model>/train.jsonl")
    parser.add_argument("--out", default=None, help="Default: outputs/<model>/run-<time>")
    parser.add_argument("--from-adapter", default=None, help="Continue training an existing ARO adapter")
    args = parser.parse_args()
    data = args.data or f"{CONFIG.data_dir}/{args.model}/train.jsonl"
    out = args.out or f"{CONFIG.output_dir}/{args.model}/run-{time.strftime('%Y%m%d-%H%M')}"
    train(data, out, init_adapter=args.from_adapter, model_id=args.model)


if __name__ == "__main__":
    main()
