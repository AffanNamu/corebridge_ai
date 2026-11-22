# ARO training pipeline

This folder builds **ARO**, ARO AI's own model, and improves it every day from user feedback.

```
users' 👍 / 👎 + corrections (opt-in only)
        │
        ▼
prepare ──► train ──► evaluate ──► publish ──► serve (vLLM) ──► ai-router / aro-agent ──► app
   ▲                     │ (must beat the current version,
   └── replay of older   │  no regressions on identity/safety)
       data (no forgetting)
```

| Step | Module | What it does |
|---|---|---|
| Prepare | `aro_training.prepare` | Starter data on the first run (OpenAssistant oasst2, human-written, Apache-2.0) + ARO identity (`seed/identity.jsonl`) + new user feedback from Firestore. Removes personal data and secrets, drops duplicates, mixes in older data. |
| Train | `aro_training.train` | QLoRA fine-tune of `Qwen/Qwen3-4B` (Apache-2.0) with Unsloth. Output is a small LoRA adapter. |
| Evaluate | `aro_training.evaluate` | Candidate vs current on `eval/eval_set.jsonl` (rubric, plus an optional judge model). Publishes only if better by `ARO_PROMOTE_MARGIN` and nothing critical regresses. |
| Publish | `aro_training.promote` | Uploads the adapter to a private Hugging Face repo (`versions/<v>/`) and moves `current.json`. `promote rollback` goes back one version. |
| Serve | `scripts/serve_vllm.sh` | vLLM OpenAI-compatible server with tool calling (for the GitHub agent) and Qwen3 reasoning. |

## What data is used — and what never is

* **Only** users who turned on *Settings → Help improve ARO* (`users/{uid}.trainingConsent`).
* **Only** answers ARO itself produced (`servedBy == "aro"`) that the user rated, or the user's correction after a 👎. Unrated answers are skipped, because a model trained on its own unchecked output gets worse.
* **Never** answers from Claude, ChatGPT, Gemini or Qwen, or from the backup model. Their terms forbid training a competing model on their outputs.
* Emails, phone numbers, card numbers, IPs, API keys, tokens and passwords are replaced with placeholders (`aro_training/clean.py`). User ids are replaced with one-way hashes.

## Run it on free Google Colab (testing)

Open [`ARO_1_5_Colab.ipynb`](ARO_1_5_Colab.ipynb) in Colab (File → Upload notebook, or open it from GitHub), choose a **T4 GPU**, add the secrets listed at the top, and run the cells. At the end it prints the URL to put in Supabase:

```
supabase secrets set ARO_MODEL_BASE_URL=https://<printed>.trycloudflare.com/v1 \
                     ARO_MODEL_API_KEY=<same as the Colab secret> \
                     ARO_MODEL_NAME=aro-1.5
```

Colab sessions end after a few hours, and the URL changes every session. Set the backup model secrets too (`ARO_FALLBACK_BASE_URL`, `ARO_FALLBACK_API_KEY`, `ARO_FALLBACK_MODEL`) so chat keeps working while ARO is offline. Backup answers are labelled in the app and never used for training.

## Run it every day (production)

Rent a GPU with 24 GB, for example an RTX 4090 on RunPod or Vast.ai (about $0.30–0.70/hour). Then:

```bash
git clone -b aro-ai-v1 https://github.com/AffanNamu/corebridge_ai && cd corebridge_ai/training
pip install -e '.[train]' vllm
export HF_TOKEN=... ARO_HUB_REPO=your-org/aro-1.5 ARO_MODEL_API_KEY=...
export GOOGLE_APPLICATION_CREDENTIALS=/secure/firebase-service-account.json

./scripts/live_server.sh start     # the live model the app talks to (port 8000)
crontab -e                         # add the daily cycle at a quiet hour:
# 17 2 * * *  cd /path/to/corebridge_ai/training && ./scripts/daily.sh >> daily.log 2>&1
```

Expose port 8000 over HTTPS, for example with RunPod's HTTP proxy or a Cloudflare tunnel, and put that URL in `ARO_MODEL_BASE_URL`.

One GPU can't train and serve at the same time. So `daily.sh` pauses the live server, prepares the data and trains. It then serves the candidate next to the current version for evaluation, publishes the candidate only if it wins, and always restarts the live server with the current version. That takes about an hour; during it the app uses the backup model. To undo a version, run `python -m aro_training.promote rollback`, then `./scripts/live_server.sh stop && ./scripts/live_server.sh start`.

If there's no new feedback that day, the cycle stops early and no GPU time is spent training.

## Tests

```bash
pip install -e '.[dev]' && pytest -q
```

The tests cover the data rules above (consent, ARO-only, ratings), scrubbing, de-duplication, replay mixing, evaluation decisions and version rollback. They need no GPU.
