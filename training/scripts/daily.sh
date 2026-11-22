#!/usr/bin/env bash
# One full daily cycle on a single GPU machine (e.g. a rented RTX 4090):
#   pause the live server → prepare data → train → serve current + candidate
#   → evaluate → publish if better → restart the live server (always).
#
# One GPU can't train and serve at the same time, so the live server is
# paused for the run (about an hour); the app uses the backup model
# (ARO_FALLBACK_* in Supabase) meanwhile. Schedule it for a quiet hour:
#   17 2 * * *  cd /path/to/corebridge_ai/training && ./scripts/daily.sh >> daily.log 2>&1
#
# Needs: GOOGLE_APPLICATION_CREDENTIALS (Firebase service account, for user
# feedback), HF_TOKEN and ARO_HUB_REPO (to publish), and the training extras.
set -uo pipefail
cd "$(dirname "$0")/.."

RUN="outputs/run-$(date -u +%Y%m%d-%H%M)"
mkdir -p "$RUN"

./scripts/live_server.sh stop

# Whatever happens below, bring the live model back.
trap './scripts/live_server.sh start' EXIT

python -m aro_training.prepare
status=$?
if [ $status -eq 2 ]; then echo "No new feedback today."; exit 0; fi
if [ $status -ne 0 ]; then echo "prepare failed"; exit $status; fi

python -m aro_training.train --data data/train.jsonl --out "$RUN" || { echo "training failed"; exit 1; }

ARO_CANDIDATE="$RUN/adapter" ./scripts/serve_vllm.sh > "$RUN/eval_server.log" 2>&1 &
EVAL_SERVER=$!
for _ in $(seq 1 120); do
  curl -sf -H "Authorization: Bearer ${ARO_MODEL_API_KEY:-none}" http://localhost:8000/v1/models > /dev/null && break
  sleep 5
done

if python -m aro_training.evaluate --base-url http://localhost:8000/v1 --api-key "${ARO_MODEL_API_KEY:-none}" \
     --candidate aro-candidate --current "${ARO_MODEL_NAME:-aro-1.5}" --report "$RUN/eval_report.json"; then
  python -m aro_training.promote publish "$RUN/adapter" --report "$RUN/eval_report.json"
  echo "New ARO version published."
else
  echo "Candidate was not better — keeping the current version."
fi

kill "$EVAL_SERVER" 2>/dev/null; wait "$EVAL_SERVER" 2>/dev/null
# The EXIT trap restarts the live server with the current published version.
