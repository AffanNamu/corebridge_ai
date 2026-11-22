#!/usr/bin/env bash
# One full daily cycle on a single GPU machine (e.g. a rented RTX 4090), for
# every ARO text model that has new feedback (ARO 1.5, Code, Research, Translate):
#   pause the live server → prepare data → train each model → serve current +
#   candidates → evaluate each → publish the ones that win → restart live (always).
#
# One GPU can't train and serve at the same time, so the live server is
# paused for the run; the app uses the backup model (ARO_FALLBACK_* in
# Supabase) meanwhile. Schedule it for a quiet hour:
#   17 2 * * *  cd /path/to/corebridge_ai/training && ./scripts/daily.sh >> daily.log 2>&1
#
# Needs: GOOGLE_APPLICATION_CREDENTIALS (Firebase service account, for user
# feedback), HF_TOKEN and ARO_HUB_NAMESPACE (to publish), the training extras.
set -uo pipefail
cd "$(dirname "$0")/.."

STAMP="run-$(date -u +%Y%m%d-%H%M)"

./scripts/live_server.sh stop
trap './scripts/live_server.sh start' EXIT   # whatever happens, bring the live models back

python -m aro_training.prepare --model all
status=$?
if [ $status -eq 2 ]; then echo "No new feedback today."; exit 0; fi
if [ $status -ne 0 ]; then echo "prepare failed"; exit $status; fi

MODELS=$(python -c "import json; print(' '.join(m for m, n in json.load(open('data/prepared.json')).items() if n))")
CANDIDATES=""
for MODEL in $MODELS; do
  OUT="outputs/$MODEL/$STAMP"
  if python -m aro_training.train --model "$MODEL" --out "$OUT"; then
    CANDIDATES="${CANDIDATES:+$CANDIDATES,}$MODEL=$OUT/adapter"
  else
    echo "[$MODEL] training failed — skipping"
  fi
done
[ -z "$CANDIDATES" ] && { echo "Nothing trained."; exit 1; }

ARO_CANDIDATES="$CANDIDATES" ./scripts/serve_vllm.sh > "outputs/eval_server_$STAMP.log" 2>&1 &
EVAL_SERVER=$!
for _ in $(seq 1 120); do
  curl -sf -H "Authorization: Bearer ${ARO_MODEL_API_KEY:-none}" http://localhost:8000/v1/models > /dev/null && break
  sleep 5
done

for PAIR in ${CANDIDATES//,/ }; do
  MODEL="${PAIR%%=*}"; ADAPTER="${PAIR#*=}"; OUT="$(dirname "$ADAPTER")"
  # A specialist with no published version yet is compared against ARO 1.5.
  CURRENT=$(curl -sf -H "Authorization: Bearer ${ARO_MODEL_API_KEY:-none}" http://localhost:8000/v1/models \
            | python -c "import json,sys; ids=[m['id'] for m in json.load(sys.stdin)['data']]; print('$MODEL' if '$MODEL' in ids else 'aro-1.5')")
  if python -m aro_training.evaluate --model "$MODEL" --base-url http://localhost:8000/v1 \
       --api-key "${ARO_MODEL_API_KEY:-none}" --candidate "$MODEL-candidate" --current "$CURRENT" \
       --report "$OUT/eval_report.json"; then
    python -m aro_training.promote --model "$MODEL" publish "$ADAPTER" --report "$OUT/eval_report.json"
  else
    echo "[$MODEL] candidate was not better — keeping the current version."
  fi
done

kill "$EVAL_SERVER" 2>/dev/null; wait "$EVAL_SERVER" 2>/dev/null
python -m aro_training.compare
# The EXIT trap restarts the live server with every model's current version.
