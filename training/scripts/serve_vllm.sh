#!/usr/bin/env bash
# Serves every ARO text model (ARO 1.5, Code, Research, Translate) with vLLM
# as an OpenAI-compatible API — one base model, one LoRA adapter per model.
#
#   ARO_HUB_NAMESPACE=your-hf-org ./scripts/serve_vllm.sh   # current published versions
#   ARO_ADAPTER_ARO_CODE=outputs/aro-code/run-x/adapter ./scripts/serve_vllm.sh   # a local adapter
#   ARO_CANDIDATES=aro-code=outputs/aro-code/run-y/adapter ./scripts/serve_vllm.sh   # + "aro-code-candidate" for evaluation
#
# Set ARO_MODEL_API_KEY to require a key (put the same value in Supabase).
set -euo pipefail
cd "$(dirname "$0")/.."
CMD=$(python -m aro_training.serve)
echo "$CMD"
eval "exec $CMD"
