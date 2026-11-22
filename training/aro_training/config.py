"""Settings for the ARO training pipeline. Override with environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass, field


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default)


@dataclass(frozen=True)
class Config:
    # Base model ARO is fine-tuned from. Qwen3 models are Apache-2.0, which
    # allows commercial use. (Avoid Qwen2.5-3B: its license is research-only.)
    base_model: str = _env("ARO_BASE_MODEL", "Qwen/Qwen3-4B")
    # Name users see in the app, and the LoRA/served model name on vLLM.
    model_name: str = _env("ARO_MODEL_NAME", "aro-1.5")
    # Private Hugging Face repo where each accepted version is pushed.
    hub_repo: str = _env("ARO_HUB_REPO", "")
    data_dir: str = _env("ARO_DATA_DIR", "data")
    output_dir: str = _env("ARO_OUTPUT_DIR", "outputs")

    # Training (QLoRA). Sized for a free Colab T4 (16 GB).
    max_seq_length: int = int(_env("ARO_MAX_SEQ", "2048"))
    lora_rank: int = int(_env("ARO_LORA_RANK", "16"))
    learning_rate: float = float(_env("ARO_LR", "2e-4"))
    epochs: float = float(_env("ARO_EPOCHS", "1"))
    batch_size: int = int(_env("ARO_BATCH", "2"))
    grad_accum: int = int(_env("ARO_GRAD_ACCUM", "4"))

    # Share of each day's training set taken from older data, so the model
    # doesn't forget what it already knew.
    replay_ratio: float = float(_env("ARO_REPLAY_RATIO", "0.5"))
    # A new version must beat the current one by at least this much.
    promote_margin: float = float(_env("ARO_PROMOTE_MARGIN", "0.02"))

    system_prompt: str = field(
        default=(
            "You are ARO, the assistant built into ARO AI. Your model is ARO 1.5. "
            "Be accurate, concise and helpful. If you are not sure about something, say so."
        )
    )


CONFIG = Config()
