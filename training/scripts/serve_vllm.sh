#!/usr/bin/env bash
# Serves ARO with vLLM as an OpenAI-compatible API on port 8000.
#
#   ARO_ADAPTER=outputs/run-x/adapter ./scripts/serve_vllm.sh   # a local adapter
#   ARO_HUB_REPO=your-org/aro-1.5    ./scripts/serve_vllm.sh   # the current published version
#   ./scripts/serve_vllm.sh                                     # base model only, named aro-1.5
#
# Optional: ARO_CANDIDATE=outputs/run-y/adapter also serves "aro-candidate"
# (used by aro_training.evaluate). Set ARO_MODEL_API_KEY to require a key —
# put the same value in the Supabase secret ARO_MODEL_API_KEY.
set -euo pipefail

BASE="${ARO_BASE_MODEL:-Qwen/Qwen3-4B}"
NAME="${ARO_MODEL_NAME:-aro-1.5}"
ADAPTER="${ARO_ADAPTER:-}"

if [ -z "$ADAPTER" ] && [ -n "${ARO_HUB_REPO:-}" ]; then
  VERSION=$(python -c "import json,huggingface_hub as h; print(json.load(open(h.hf_hub_download('$ARO_HUB_REPO','current.json')))['version'])" 2>/dev/null || true)
  if [ -n "$VERSION" ]; then
    ADAPTER=$(python -c "import huggingface_hub as h; print(h.snapshot_download('$ARO_HUB_REPO', allow_patterns=['versions/$VERSION/*']))")/versions/$VERSION
    echo "Serving published ARO version $VERSION"
  fi
fi

ARGS=(--host 0.0.0.0 --port 8000 --max-model-len "${ARO_MAX_SEQ:-8192}"
      --enable-auto-tool-choice --tool-call-parser hermes --reasoning-parser qwen3)

# T4 / older GPUs have no bfloat16.
if python -c "import torch,sys; sys.exit(0 if torch.cuda.is_bf16_supported() else 1)" 2>/dev/null; then
  ARGS+=(--dtype bfloat16)
else
  ARGS+=(--dtype half)
fi

if [ -n "${ARO_MODEL_API_KEY:-}" ]; then ARGS+=(--api-key "$ARO_MODEL_API_KEY"); fi

if [ -n "$ADAPTER" ] || [ -n "${ARO_CANDIDATE:-}" ]; then
  MODULES=()
  if [ -n "$ADAPTER" ]; then MODULES+=("$NAME=$ADAPTER"); fi
  if [ -n "${ARO_CANDIDATE:-}" ]; then MODULES+=("aro-candidate=$ARO_CANDIDATE"); fi
  # With no published adapter yet, the base model answers as "aro-1.5".
  if [ -z "$ADAPTER" ]; then ARGS+=(--served-model-name "$NAME"); fi
  ARGS+=(--enable-lora --max-lora-rank 64 --lora-modules "${MODULES[@]}")
else
  ARGS+=(--served-model-name "$NAME")
fi

exec vllm serve "$BASE" "${ARGS[@]}"
