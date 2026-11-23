#!/usr/bin/env bash
# Train, evaluate and serve ARO's text models (ARO 1.5, Code, Research,
# Translate) on a RunPod GPU pod — no API keys needed.
#
# Pod: a GPU with 24 GB+ (RTX 4090, A5000, L4, A10…), any PyTorch template,
# volume disk 80 GB+ mounted at /workspace, and HTTP port 8000 exposed
# (Edit Pod → Expose HTTP Ports → 8000).
#
# In the pod's web terminal, run:
#   curl -fsSL https://raw.githubusercontent.com/AffanNamu/corebridge_ai/aro-ai-v1/training/scripts/runpod_train.sh -o /workspace/aro_train.sh && bash /workspace/aro_train.sh
#
# It runs in the background (closing the terminal is fine). Progress:
#   https://<POD_ID>-8000.proxy.runpod.net/status.json   while training
#   tail -f /workspace/aro/run.log                         in the terminal
#
# Cost: when it finishes, accepted versions are in /workspace/aro/live on the
# network volume — the serverless ARO endpoint (scale to zero) serves them
# from there — and the pod STOPS ITSELF so the GPU isn't billed while idle.
#   ARO_SERVE_AFTER=1   keep serving from this pod instead (old behaviour, billed 24/7)
#   ARO_AUTOSTOP=0      leave the pod running when done
# Interruptible (spot) pods are fine: training saves checkpoints, and running
# the script again resumes an interrupted model where it stopped.
set -uo pipefail

BASE=/workspace/aro
REPO="$BASE/corebridge_ai"
LOG="$BASE/run.log"
PUBLIC="$BASE/public"
# ARO_MODELS="aro-1.5 aro-translate" retrains only those; ARO_REBUILD=1 rebuilds
# their training data from scratch (after a data-pipeline fix).
ALL_MODELS=(aro-1.5 aro-code aro-research aro-translate)
read -r -a MODELS <<< "${ARO_MODELS:-${ALL_MODELS[*]}}"

mkdir -p "$BASE" "$PUBLIC"
export HF_HOME="$BASE/hf-cache" PIP_CACHE_DIR="$BASE/pip-cache" HF_HUB_ENABLE_HF_TRANSFER=0

# Re-launch detached so the run survives closing the terminal.
if [ -z "${ARO_DETACHED:-}" ]; then
  # A previous run may still be serving on :8000 and holding the GPU.
  [ -s "$BASE/run.pid" ] && kill "$(cat "$BASE/run.pid")" 2>/dev/null
  pkill -f "vllm serve" 2>/dev/null; pkill -f "http.server 8000" 2>/dev/null
  sleep 5
  ARO_DETACHED=1 nohup bash "$0" "$@" >> "$LOG" 2>&1 &
  echo $! > "$BASE/run.pid"
  echo "ARO training started in the background (pid $!)."
  echo "Watch it:  tail -f $LOG"
  [ -n "${RUNPOD_POD_ID:-}" ] && echo "Status:    https://${RUNPOD_POD_ID}-8000.proxy.runpod.net/status.json"
  exit 0
fi

say() { echo "[$(date -u +%H:%M:%S)] $*"; }
status() {  # stage, detail → public/status.json (+ last log lines), read by the status server
  python3 - "$1" "$2" <<'EOF'
import json, sys, time, pathlib
base = pathlib.Path("/workspace/aro")
lines = (base / "run.log").read_text(errors="replace").splitlines()[-40:] if (base / "run.log").exists() else []
(base / "public" / "status.json").write_text(json.dumps(
    {"stage": sys.argv[1], "detail": sys.argv[2], "updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "log": lines}, indent=2))
EOF
}

# ------------------------------------------------------------ status page
python3 -m http.server 8000 --directory "$PUBLIC" > /dev/null 2>&1 &
STATUS_SERVER=$!
status starting "setting up"
say "GPU: $(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null || echo none)"

# ------------------------------------------------------------------- code
if [ -d "$REPO/.git" ]; then git -C "$REPO" pull --ff-only; else git clone --depth 1 -b aro-ai-v1 https://github.com/AffanNamu/corebridge_ai "$REPO"; fi
cd "$REPO/training"

# The key apps must send to this server. Generated once, kept on the volume.
KEY_FILE="$BASE/api_key"
[ -s "$KEY_FILE" ] || python3 -c "import secrets; print('aro-' + secrets.token_urlsafe(32))" > "$KEY_FILE"
chmod 600 "$KEY_FILE"
export ARO_MODEL_API_KEY="$(cat "$KEY_FILE")"

# uv makes the two environments (training and serving need different library
# versions) and brings its own Python if the image has none suitable.
command -v uv > /dev/null || python3 -m pip install -q uv || curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.local/bin:$PATH" UV_CACHE_DIR="$BASE/uv-cache"
venv() {  # venv <dir> <packages…>
  local dir="$1"; shift
  [ -x "$dir/bin/python" ] || uv venv -q --python 3.11 "$dir"
  uv pip install -q --python "$dir/bin/python" "$@"
}

# --------------------------------------------------------- 1. train
status installing "training libraries"
venv "$BASE/train-venv" unsloth "trl>=0.12" "peft>=0.12" "transformers>=4.51" accelerate bitsandbytes datasets huggingface_hub -e .

STAMP="run-$(date -u +%Y%m%d-%H%M)"
declare -A RUN_OF
status preparing "building training data (license-gated): ${MODELS[*]}"
for M in "${MODELS[@]}"; do
  RESUME="$BASE/outputs/$M/in_progress"
  if [ -s "$RESUME" ] && [ -s "$BASE/data/$M/train.jsonl" ] && [ "${ARO_REBUILD:-}" != "1" ]; then
    RUN_OF[$M]="$(cat "$RESUME")"           # interrupted last time: finish that run
    say "[$M] resuming ${RUN_OF[$M]}"
    continue
  fi
  [ "${ARO_REBUILD:-}" = "1" ] && rm -rf "$BASE/data/$M"
  "$BASE/train-venv/bin/python" -m aro_training.prepare --model "$M" --no-users --data-dir "$BASE/data"
  case $? in
    0) RUN_OF[$M]="$STAMP"; mkdir -p "$BASE/outputs/$M"; echo "$STAMP" > "$RESUME" ;;
    2) say "[$M] nothing new to learn — skipped" ;;   # don't retrain on yesterday's file
    *) say "[$M] preparing data FAILED" ;;
  esac
done

TRAINED=()
for M in "${MODELS[@]}"; do
  RUN="${RUN_OF[$M]:-}"
  [ -n "$RUN" ] && [ -s "$BASE/data/$M/train.jsonl" ] || continue
  status training "$M ($(wc -l < "$BASE/data/$M/train.jsonl") examples)"
  say "[$M] training"
  if "$BASE/train-venv/bin/python" -m aro_training.train --model "$M" \
       --data "$BASE/data/$M/train.jsonl" --out "$BASE/outputs/$M/$RUN"; then
    TRAINED+=("$M")
    rm -f "$BASE/outputs/$M/in_progress"
    rm -rf "$BASE/outputs/$M/$RUN/checkpoints"     # the adapter is saved; free the volume
  else
    say "[$M] training FAILED (run again to resume from the last checkpoint)"
  fi
done

# ----------------------------------------------- 2. evaluate (vLLM)
status installing "serving libraries"
venv "$BASE/serve-venv" vllm -e .
export PATH="$BASE/serve-venv/bin:$PATH"

serve() {  # serve [candidates]: starts vLLM on :8000 with the adapters in $BASE/live
  kill "$STATUS_SERVER" 2>/dev/null; wait "$STATUS_SERVER" 2>/dev/null
  for M in "${ALL_MODELS[@]}"; do
    VAR="ARO_ADAPTER_$(echo "$M" | tr 'a-z.-' 'A-Z__')"
    if [ -d "$BASE/live/$M" ]; then export "$VAR=$BASE/live/$M"; else unset "$VAR"; fi
  done
  ARO_CANDIDATES="${1:-}" nohup ./scripts/serve_vllm.sh >> "$BASE/vllm.log" 2>&1 &
  VLLM=$!
  for _ in $(seq 1 180); do
    curl -sf -H "Authorization: Bearer $ARO_MODEL_API_KEY" http://localhost:8000/v1/models > /dev/null && return 0
    kill -0 "$VLLM" 2>/dev/null || break
    sleep 5
  done
  say "vLLM did not start — see $BASE/vllm.log"; tail -30 "$BASE/vllm.log"; return 1
}

CANDS=""
for M in "${TRAINED[@]}"; do CANDS="${CANDS:+$CANDS,}$M=$BASE/outputs/$M/${RUN_OF[$M]}/adapter"; done

if [ -n "$CANDS" ]; then
  status evaluating "comparing new versions with the current ones"
  if serve "$CANDS"; then
    SERVED=$(curl -sf -H "Authorization: Bearer $ARO_MODEL_API_KEY" http://localhost:8000/v1/models | python3 -c "import json,sys; print(' '.join(m['id'] for m in json.load(sys.stdin)['data']))")
    for M in "${TRAINED[@]}"; do
      if [ -d "$BASE/live/$M" ] && [[ " $SERVED " == *" $M "* ]]; then CURRENT="$M"; else CURRENT="aro-1.5"; fi
      say "[$M] evaluating against $CURRENT"
      if python -m aro_training.evaluate --model "$M" --base-url http://localhost:8000/v1 --api-key "$ARO_MODEL_API_KEY" \
           --candidate "$M-candidate" --current "$CURRENT" --report "$BASE/outputs/$M/${RUN_OF[$M]}/eval_report.json"; then
        # Swap in place: workers that start later load the new version.
        rm -rf "$BASE/live/$M.new"; mkdir -p "$BASE/live"; cp -r "$BASE/outputs/$M/${RUN_OF[$M]}/adapter" "$BASE/live/$M.new"
        rm -rf "$BASE/live/$M"; mv "$BASE/live/$M.new" "$BASE/live/$M"
        say "[$M] ✅ new version accepted"
      else
        say "[$M] kept the current version"
      fi
    done
    python -m aro_training.compare | tee "$PUBLIC/leaderboard.md"
    pkill -f "vllm serve" ; sleep 10
  fi
fi

# ---------------------------------------------- 3. hand over and stop
if [ "${ARO_SERVE_AFTER:-}" != "1" ]; then
  status done "finished — accepted versions are in $BASE/live: $(ls "$BASE/live" 2>/dev/null | tr '\n' ' ')"
  say "Done. Adapters in $BASE/live: $(ls "$BASE/live" 2>/dev/null | tr '\n' ' ')"
  say "The serverless ARO endpoint loads them from the network volume at its next cold start."
  say "A newly accepted model must be listed in the endpoint's VLLM_EXTRA_ARGS (--lora-modules name=/runpod-volume/aro/live/name)."
  kill "$STATUS_SERVER" 2>/dev/null
  if [ "${ARO_AUTOSTOP:-1}" = "1" ] && [ -n "${RUNPOD_POD_ID:-}" ] && command -v runpodctl > /dev/null; then
    say "Stopping this pod so the GPU isn't billed while idle (ARO_AUTOSTOP=0 to keep it)."
    sleep 5
    runpodctl pod stop "$RUNPOD_POD_ID" || runpodctl stop pod "$RUNPOD_POD_ID" || say "Could not stop the pod — stop it in the RunPod console."
  fi
  exit 0
fi

status serving "starting the ARO model server"
if serve ""; then
  say "ARO is being served on port 8000 (billed while this pod runs)."
  say "Models: $(curl -sf -H "Authorization: Bearer $ARO_MODEL_API_KEY" http://localhost:8000/v1/models | python3 -c "import json,sys; print(', '.join(m['id'] for m in json.load(sys.stdin)['data']))")"
  say "URL for Supabase (ARO_MODEL_BASE_URL): https://${RUNPOD_POD_ID:-<POD_ID>}-8000.proxy.runpod.net/v1"
  say "API key for Supabase (ARO_MODEL_API_KEY): run   cat $KEY_FILE   in this terminal"
  wait "$VLLM"
else
  status failed "the model server did not start — see $BASE/vllm.log"
fi
