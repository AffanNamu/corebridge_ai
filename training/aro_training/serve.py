"""Builds the vLLM command that serves every ARO text model from one GPU.

The shared foundation (Qwen3-4B) is loaded once; ARO 1.5, Code, Research
and Translate are LoRA adapters on top, each under its own model name.
A model with no published adapter yet simply isn't served — ai-router then
answers with ARO 1.5 instead.

    python -m aro_training.serve              # prints the command
    scripts/serve_vllm.sh                     # runs it
"""

from __future__ import annotations

import json
import os
import shlex
import sys
from pathlib import Path

from .models import trainable_specs


def current_adapter(repo: str) -> Path | None:
    """Downloads the version that current.json points at; None if nothing published."""
    if not repo:
        return None
    try:
        from huggingface_hub import hf_hub_download, snapshot_download

        version = json.loads(Path(hf_hub_download(repo, "current.json")).read_text())["version"]
        return Path(snapshot_download(repo, allow_patterns=[f"versions/{version}/*"])) / "versions" / version
    except Exception as err:  # not published yet, offline, no access…
        print(f"# no published adapter in {repo}: {type(err).__name__}", file=sys.stderr)
        return None


def build_command(
    adapters: dict[str, Path | str],
    base_model: str,
    port: int = 8000,
    max_len: int = 8192,
    api_key: str | None = None,
    bf16: bool = True,
    candidate: str | None = None,
    candidates: dict[str, Path | str] | None = None,
) -> list[str]:
    cmd = ["vllm", "serve", base_model, "--host", "0.0.0.0", "--port", str(port), "--max-model-len", str(max_len),
           "--enable-auto-tool-choice", "--tool-call-parser", "hermes", "--reasoning-parser", "qwen3",
           "--dtype", "bfloat16" if bf16 else "half"]
    if api_key:
        cmd += ["--api-key", api_key]
    modules = [f"{name}={path}" for name, path in adapters.items()]
    if candidate:
        modules.append(f"aro-candidate={candidate}")
    for name, path in (candidates or {}).items():
        modules.append(f"{name}-candidate={path}")
    if "aro-1.5" not in adapters:
        # Nothing trained yet: the base model answers as "aro-1.5".
        cmd += ["--served-model-name", "aro-1.5"]
    if modules:
        cmd += ["--enable-lora", "--max-lora-rank", "64", "--max-loras", str(max(4, len(modules))), "--lora-modules", *modules]
    return cmd


def parse_candidates(value: str) -> dict[str, str]:
    """ARO_CANDIDATES="aro-code=path/a,aro-research=path/b" → {"aro-code": "path/a", ...}."""
    pairs = [item.split("=", 1) for item in value.split(",") if "=" in item]
    return {name.strip(): path.strip() for name, path in pairs}


def main() -> None:
    adapters: dict[str, Path | str] = {}
    for model in trainable_specs():
        local = os.environ.get(f"ARO_ADAPTER_{model.id.upper().replace('-', '_').replace('.', '_')}")
        path = Path(local) if local else current_adapter(model.hub_repo())
        if path:
            adapters[model.served_name] = path
    try:
        import torch

        bf16 = torch.cuda.is_available() and torch.cuda.is_bf16_supported()
    except ImportError:
        bf16 = True
    cmd = build_command(
        adapters,
        base_model=os.environ.get("ARO_BASE_MODEL", trainable_specs()[0].base_model),
        port=int(os.environ.get("ARO_PORT", "8000")),
        max_len=int(os.environ.get("ARO_MAX_SEQ", "8192")),
        api_key=os.environ.get("ARO_MODEL_API_KEY") or None,
        bf16=bf16,
        candidate=os.environ.get("ARO_CANDIDATE") or None,
        candidates=parse_candidates(os.environ.get("ARO_CANDIDATES", "")),
    )
    print(shlex.join(cmd))


if __name__ == "__main__":
    main()
