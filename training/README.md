# ARO training pipeline and Data Engine

This folder builds ARO AI's own **text models** — ARO 1.5, ARO Code, ARO Research and ARO Translate — and improves them every day from user feedback. All four share one base model (`Qwen/Qwen3-4B`, Apache-2.0); each is a small LoRA adapter. Vision, Voice and Creative use specialist models (see [docs/MODELS.md](../docs/MODELS.md)).

```
Data Engine (registry + license gate)      users' 👍 / 👎 + corrections (opt-in only)
        │                                            │
        └────────────────────┬───────────────────────┘
                             ▼
prepare (per model) ──► train ──► evaluate ──► publish ──► serve (one vLLM, 4 adapters) ──► app
   ▲   no test-set overlap,          │ (must beat the current version,
   │   provenance manifest           │  no regressions on identity/safety)
   └── replay of older data (no forgetting)
```

| Step | Module | What it does |
|---|---|---|
| Data Engine | `aro_data` | Registry of every dataset (`aro_data/registry/datasets.json`, documented in [`aro_data/DATASETS.md`](aro_data/DATASETS.md)) with source, version, license, commercial status, allowed uses and model assignment. The license gate (`assert_trainable`) refuses anything not cleared. Also: license re-check against Hugging Face, provenance manifests with checksums, cleaning, language ID, contamination checks. |
| Prepare | `aro_training.prepare --model <id>` | Starter data on the first run (per model, below) + ARO identity + that model's user feedback. Removes personal data and secrets, drops duplicates and anything overlapping the model's test set, mixes in older data, writes a manifest. |
| Train | `aro_training.train --model <id>` | QLoRA fine-tune with Unsloth. Output is a small LoRA adapter. |
| Evaluate | `aro_training.evaluate --model <id>` | Candidate vs current on `eval/<id>.jsonl` (rubric, accent-insensitive, plus an optional judge model). Records latency, tokens/s and per-category scores in `results/leaderboard.jsonl` (and the admin dashboard). Publishes only if better by `ARO_PROMOTE_MARGIN` and nothing critical regresses. |
| Publish | `aro_training.promote --model <id>` | Uploads the adapter to the model's private Hugging Face repo (`<ARO_HUB_NAMESPACE>/<id>`, `versions/<v>/`) and moves `current.json`. `rollback` goes back one version. |
| Compare | `aro_training.compare` | Every evaluation, per model, newest first. |
| Serve | `scripts/serve_vllm.sh` | One vLLM server: the base model + every published adapter, with tool calling (for the GitHub agent) and Qwen3 reasoning. |

| Model | Starter data (all ✅ cleared by the license gate) |
|---|---|
| ARO 1.5 | OpenAssistant oasst2 (Apache-2.0), Aya (Apache-2.0), GSM8K (MIT) |
| ARO Code | CodeContests (CC-BY-4.0, Python 3 solutions), oasst2 |
| ARO Research | GSM8K (step-by-step), CodeContests |
| ARO Translate | Google SMOL (CC-BY-4.0: Hausa, Yoruba, Igbo, Pidgin, Fulfulde, Swahili, Amharic, Wolof, Zulu, Xhosa), Aya |

```bash
python -m aro_data validate            # registry complete and consistent
python -m aro_data license-check       # licenses still match Hugging Face
python -m aro_data sources aro-translate
python -m aro_data card                # regenerate DATASETS.md
```

## What data is used — and what never is

* **Only** users who turned on *Settings → Help improve ARO* (`users/{uid}.trainingConsent`).
* **Only** answers ARO itself produced (`servedBy == "aro"`) that the user rated, or the user's correction after a 👎. Unrated answers are skipped, because a model trained on its own unchecked output gets worse.
* **Never** answers from Claude, ChatGPT, Gemini or Qwen, or from the backup model. Their terms forbid training a competing model on their outputs.
* Emails, phone numbers, card numbers, IPs, API keys, tokens and passwords are replaced with placeholders (`aro_training/clean.py`). User ids are replaced with one-way hashes.

## Run it on free Google Colab (testing)

Open [`ARO_1_5_Colab.ipynb`](ARO_1_5_Colab.ipynb) in Colab (File → Upload notebook, or open it from GitHub), choose a **T4 GPU**, add the secrets listed at the top, set `MODEL` in the first code cell (`aro-1.5`, `aro-code`, `aro-research` or `aro-translate`) and run the cells. Train ARO 1.5 first; the specialists answer through ARO 1.5 until their own adapters are published. At the end it prints the URL to put in Supabase:

```
supabase secrets set ARO_MODEL_BASE_URL=https://<printed>.trycloudflare.com/v1 \
                     ARO_MODEL_API_KEY=<same as the Colab secret>
```

Colab sessions end after a few hours, and the URL changes every session. Set the backup model secrets too (`ARO_FALLBACK_BASE_URL`, `ARO_FALLBACK_API_KEY`, `ARO_FALLBACK_MODEL`) so chat keeps working while ARO is offline. Backup answers are labelled in the app and never used for training.

## Run it on RunPod (one command)

Create a pod:
- **GPU** with 24 GB or more (RTX 4090, A5000, L4, A10…)
- any PyTorch template
- **volume disk** of 80 GB or more
- **HTTP port 8000** exposed (*Edit Pod → Expose HTTP Ports*)

Then run this in the pod's web terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/AffanNamu/corebridge_ai/aro-ai-v1/training/scripts/runpod_train.sh -o /workspace/aro_train.sh && bash /workspace/aro_train.sh
```

The script runs in the background, so it survives closing the terminal. It:
1. builds the license-gated training data (models with nothing new are skipped)
2. trains ARO 1.5, Code, Research and Translate, saving checkpoints
3. evaluates each against the current version, in parallel, and keeps only the winners in `/workspace/aro/live`
4. **stops the pod** so the GPU isn't billed while idle

Progress is at `https://<POD_ID>-8000.proxy.runpod.net/status.json`, or with `tail -f /workspace/aro/run.log` in the pod. On an RTX 4090 a full first run takes about 3–5 hours.

The app is served by a RunPod **Serverless** endpoint that reads `/workspace/aro/live` from the same network volume and scales to zero when nobody is chatting (`training/serverless/aro-models.endpoint.json`, details in [docs/COSTS.md](../docs/COSTS.md)). Supabase points at it once:
1. `ARO_MODEL_BASE_URL` = `https://api.runpod.ai/v2/<endpoint id>/openai/v1`
2. `ARO_MODEL_API_KEY` = a RunPod API key restricted to that endpoint

New versions are picked up at the endpoint's next cold start. A model accepted for the first time must also be added to the endpoint's `VLLM_EXTRA_ARGS` (`--lora-modules <id>=/runpod-volume/aro/live/<id>`).

Cheaper runs: create the pod as **interruptible (spot)** in the volume's data center. If it's interrupted, start it and run the same command; each model resumes from its last checkpoint. `ARO_AUTOSTOP=0` keeps the pod running afterwards; `ARO_SERVE_AFTER=1` serves from the pod as before (billed around the clock).



Rent a GPU with 24 GB, for example an RTX 4090 on RunPod or Vast.ai (about $0.30–0.70/hour). Then:

```bash
git clone -b aro-ai-v1 https://github.com/AffanNamu/corebridge_ai && cd corebridge_ai/training
pip install -e '.[train]' vllm
export HF_TOKEN=... ARO_HUB_NAMESPACE=your-hf-org ARO_MODEL_API_KEY=...
export SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...   # optional: evaluations appear in the admin dashboard
export GOOGLE_APPLICATION_CREDENTIALS=/secure/firebase-service-account.json

./scripts/live_server.sh start     # the live model the app talks to (port 8000)
crontab -e                         # add the daily cycle at a quiet hour:
# 17 2 * * *  cd /path/to/corebridge_ai/training && ./scripts/daily.sh >> daily.log 2>&1
```

Expose port 8000 over HTTPS, for example with RunPod's HTTP proxy or a Cloudflare tunnel, and put that URL in `ARO_MODEL_BASE_URL`.

One GPU can't train and serve at the same time. So `daily.sh` pauses the live server, prepares the data and trains every text model that has new feedback. It then serves the candidates next to the current versions for evaluation, publishes each candidate only if it wins, and always restarts the live server with the current versions. That takes about an hour; during it the app uses the backup model. To undo a version, run `python -m aro_training.promote --model <id> rollback`, then `./scripts/live_server.sh stop && ./scripts/live_server.sh start`.

If there's no new feedback that day, the cycle stops early and no GPU time is spent training.

## Tests

```bash
pip install -e '.[dev]' && pytest -q
```

The tests cover the license gate and registry rules, the data rules above (consent, ARO-only, per-model routing of feedback, ratings), converters for every starter dataset, scrubbing, de-duplication, contamination removal, language ID, manifests, replay mixing, evaluation decisions and metrics, the vLLM command, version rollback, and that the database seed matches `models/`. They need no GPU.
