# Keeping ARO AI's costs under control

ARO AI pays for three things:
- **GPU time** for ARO's own models (serving and training)
- **the backup API**, if one is configured (`ARO_FALLBACK_*`)
- **Supabase**

Requests made with a user's own Claude, ChatGPT, Gemini or Qwen key are billed to that key. We still rate-limit them and record their tokens.

Every control below is enforced on the server (Postgres + Edge Functions), never in the app. All of them can be changed from the admin dashboard API without a deploy.

| Area | What we do | Where |
|---|---|---|
| Model tiering | ARO 1.5 by default; a specialist only when the request needs it; vision only with images | `_shared/aro.ts` |
| Prompt caching | Claude `cache_control`, automatic caching on OpenAI-compatible providers, vLLM prefix caching | `llm/chat_stream.ts`, `llm/tool_chat.ts`, endpoint env |
| Response cache | Repeated single-turn ARO questions answered from Postgres, no GPU | `aro_cache_*`, `_shared/cost.ts` |
| Agent caps | Steps, tokens and time per run (per plan); a loop breaker; transcript fitted to the model | `aro-agent/handler.ts`, `state.ts` |
| Context pruning | Chats fitted to ARO's window (newest first) | `fitToContext` |
| Answer length | `max_tokens` per plan | `aro_plans.max_output_tokens` |
| Rate limits | Per user, per minute and per hour, by plan, for every provider | `aro_gate` |
| Quotas | Daily requests per model per plan, credits, purchases (already in place) | `aro_authorize` |
| Serving | RunPod Serverless, scales to zero, billed per second | `training/serverless/aro-models.endpoint.json` |
| Training | The pod stops itself when done; resumable on spot pods; evaluation batched | `scripts/runpod_train.sh`, `train.py`, `evaluate.py` |
| Quantization | FP8 is opt-in and must pass the same quality gate | `serve.py`, `evaluate.py --current-base-url` |
| Tracing | One row per model call: trace id, user, model, tokens, latency, cost | `aro_usage_events` |
| Budget | Daily GPU budget with alerts at 50/80/100% and a circuit breaker | `aro_cost_settings`, `aro_log_usage`, `aro_gate` |

## 1. Model routing and caching

**Tiering.** With *ARO (Auto)*, the central router (`routeAroModel`) picks the model:
- **ARO 1.5** answers by default.
- **ARO Code, Research or Translate** answer only when the request clearly calls for them.
- **ARO Vision** answers only when the message has an image.

All four text models are LoRA adapters on one Qwen3-4B. A specialist costs the same GPU second as ARO 1.5; the credit prices only differ to reflect value. The paid backup API is used only when ARO's server fails before answering.

**Prompt caching.**
- **Claude (the user's key):** the agent marks the tool list and system prompt with an explicit `cache_control` breakpoint. Chat and the agent also set top-level automatic caching, so each new turn or step re-reads the earlier ones at about a tenth of the price. Claude only caches prompts above a model-dependent minimum size, so short chats simply don't cache.
- **OpenAI-compatible providers:** they cache long prefixes automatically.
- **ARO (vLLM):** `ENABLE_PREFIX_CACHING=true`. The system prompt and earlier turns are computed once per worker, which matters most for the agent, which re-sends a growing transcript each step.

**Response cache.** An ARO request is answered from `aro_response_cache` if all of these hold:
- it is one user message of up to 2,000 characters
- thinking is off
- the identical question (case and whitespace ignored) was answered by the same ARO model within `cache_ttl_seconds` (default 6 h)

The key is a SHA-256 of the model, the system prompt and the question. A hit:
- still counts toward the user's daily limit
- is logged with `status = 'cache_hit'` and costs $0

The app can send `cache: false` to force a fresh answer. Set `cache_ttl_seconds = 0` to turn caching off; this also empties the cache. Only answers from ARO itself are stored, never backup or bring-your-own-key answers.

**Semantic caching is deferred.** Matching *similar* questions needs:
- an embedding model on every request (more cost and latency)
- pgvector
- a similarity threshold

A wrong match returns a confidently wrong answer to a different question, and in a chat app most traffic is multi-turn, which no prompt cache can reuse anyway. Revisit it once `aro_usage_events` shows a large share of repeated single-turn questions that the exact-match cache misses.

## 2. Agent loop and context guardrails

Per run (one request to `aro-agent`), from the user's plan:

| | Free | Pro | Premium |
|---|---|---|---|
| `agent_max_steps` (model calls) | 15 | 25 | 40 |
| `agent_max_tokens` (input + output, all steps) | 150k | 600k | 1.5M |
| Time per run | 110 s (`AGENT_TIME_BUDGET_MS`) | same | same |

When a cap is hit, the run **pauses** and the user can tap *Continue*. That starts a new run, which is counted and rate-limited again. Nothing is lost: the state comes back to the app.

**Loop breaker.** If the model asks for exactly the same tool calls three times in a row, they aren't run again and the run pauses with a message.

**Context pruning.**
- **Agent:** old tool output is shortened. For ARO, the transcript is cut to fit its 32k window, dropping the oldest exchanges first, then shortening the largest file reads.
- **Chat:** ARO conversations are fitted to `ARO_CONTEXT_TOKENS` minus the answer budget. The newest messages are kept; if the last message alone is too long, its middle is removed. The meta frame reports `trimmed` when that happens.

**Answer length.** ARO's `max_tokens` comes from `aro_plans.max_output_tokens`: Free 1,024, Pro 4,096, Premium 8,192.

**Rate limits.** These apply to every provider, so a single user can't flood the functions:

| Plan | Per minute | Per hour |
|---|---|---|
| Free | 6 | 60 |
| Pro | 20 | 400 |
| Premium | 40 | 1,000 |

Over the limit, the request gets a 429 with `Retry-After` before any model or quota is touched. Admins (`ADMIN_UIDS`) skip rate limits and the budget breaker and get the largest caps. The counters are fixed windows in Postgres (`aro_rate_counters`), safe under concurrency. If the database is unreachable, bring-your-own-key requests still go through; ARO's own models stay closed.

## 3. GPU and compute

**Serving: serverless, scale to zero.** The ARO models run on RunPod Serverless. The settings are in `training/serverless/aro-models.endpoint.json`.

| Setting | Value | Why |
|---|---|---|
| GPUs | 24 GB pools `AMPERE_24` (L4/A5000/3090), `ADA_24` (4090) | Qwen3-4B bf16 + 32k context fits; two pools for availability |
| Workers | min 0, max 2 | **$0 when idle**; at most 2 GPUs even under a spike |
| Idle timeout | 30 s | a worker stays warm for follow-up messages, then stops billing |
| FlashBoot + compile cache on the volume | on | cold start was 155 s the very first time; later cold starts skip the compile |
| Weights and adapters | on the network volume | no download per cold start |

Prices while a worker runs (flex):
- **24 GB Ampere:** about $0.00019/s ($0.68/h)
- **RTX 4090:** about $0.00031/s ($1.12/h)

The old 24/7 pod cost $0.89/h, about **$21/day**, even with no users. With serverless, the cost follows traffic. For example, 1,000 ARO replies a day at about 3 s of GPU each comes to roughly $1/day, plus cold starts.

The trade-off is the **first reply after a quiet period**. It waits for a cold start, from tens of seconds up to about 2 minutes. Ways to reduce it:
- set `workers.min = 1` during busy hours (billed continuously)
- raise the idle timeout

**Batching.** vLLM batches concurrent requests on one GPU (continuous batching). `MAX_CONCURRENCY=30` lets one worker take 30 requests before the autoscaler adds a second. The evaluation step also sends its test questions in parallel (`ARO_EVAL_CONCURRENCY`, default 8), so a training run rents the GPU for minutes of evaluation, not the sum of every answer. Use `--concurrency 1` when you need clean latency numbers.

**Training pods.**
- `runpod_train.sh` no longer serves from the pod when it finishes. It copies the accepted adapters to `/workspace/aro/live` on the network volume, which the serverless endpoint reads at its next cold start. It then **stops the pod** with `runpodctl pod stop $RUNPOD_POD_ID`.
  - `ARO_AUTOSTOP=0` keeps the pod running.
  - `ARO_SERVE_AFTER=1` restores serving from the pod.
- A model with nothing new to learn is skipped. Before this change, a re-run retrained on yesterday's file.
- **Spot (interruptible) pods** are much cheaper and now safe. Training saves a checkpoint every `ARO_SAVE_STEPS` (default 100). Running the script again resumes an interrupted model from its last checkpoint. Create the pod as interruptible on the network volume's data center (EU-RO-1).
- A newly accepted model, for example the first ARO Code that beats ARO 1.5, must be added to the endpoint's `VLLM_EXTRA_ARGS` (`--lora-modules aro-code=/runpod-volume/aro/live/aro-code`). Until then the router answers with ARO 1.5.

**Quantization (opt-in, gated).** FP8 weights roughly halve memory and speed up decoding on Ada and Hopper GPUs (4090, L4, H100). That allows more concurrent requests per worker, or a smaller GPU. Try it like this:

```bash
# bf16 server on :8000 (as today), FP8 server on :8001
ARO_PORT=8001 ARO_QUANTIZATION=fp8 ARO_KV_CACHE_DTYPE=fp8 ./scripts/serve_vllm.sh &
python -m aro_training.evaluate --model aro-1.5 \
  --base-url http://localhost:8001/v1 --current-base-url http://localhost:8000/v1 \
  --candidate aro-1.5 --current aro-1.5 --api-key "$ARO_MODEL_API_KEY"
```

Adopt it only if the evaluation does **not** say "KEEP CURRENT" for a quality loss on any model. FP8 needs a tie or better, and no critical item may fail. To adopt it, set `QUANTIZATION`/`KV_CACHE_DTYPE` on the endpoint.

INT4 (AWQ/GPTQ) saves more memory but needs a quantized copy of the base model, and the LoRA adapters were trained on a different 4-bit format. Treat it as a separate experiment with the same gate. At 4B parameters the gain is small: the model already fits a 24 GB GPU with room for 32k context.

## 4. Cost monitoring and alerts

**Per-trace logging.** Every model call writes one row to `aro_usage_events`:
- `trace_id`: one per chat request or agent run; the app receives it in the `meta` frame and the agent's `usage` event
- user, surface (chat or agent), provider, model, served by, ARO model
- input, output and cached tokens, latency
- estimated cost to us
- status: `ok`, `error`, `cache_hit` or `stopped`

Prompts and answers are **never** stored there.

How the cost is estimated:
- **ARO (`served_by = 'aro'`):** latency × `gpu_usd_per_second`. This is an upper bound, because batching shares a GPU between requests.
- **Backup API:** tokens × `fallback_usd_per_mtok_in/out`. Set these to your backup provider's prices.
- **Bring-your-own-key:** $0 to us, since the user's key pays; tokens are still recorded.

`aro_spend_daily` keeps the running total for each UTC day.

**Budget, alerts and circuit breaker** (`aro_cost_settings`):

| Setting | Default | Effect |
|---|---|---|
| `daily_budget_usd` | 5 | at this spend, Free-plan requests to ARO's models get a friendly 429 ("at capacity today"); paid plans continue |
| `hard_budget_usd` | 10 | every ARO request is refused until midnight UTC; bring-your-own-key is never blocked |
| `alert_thresholds` | 0.5, 0.8, 1.0 | each fires once per day: logged, and POSTed to `ARO_ALERT_WEBHOOK_URL` (Slack `text` / Discord `content`) |
| `gpu_usd_per_second` | 0.00031 | RTX 4090 flex rate; lower it if workers mostly land on the 24 GB Ampere pool ($0.00019) |
| `cache_ttl_seconds` | 21600 | response cache lifetime; 0 = off |

**Two more safety nets, outside the app:**
- the endpoint's `workers.max = 2` caps GPU spend at about $2.24/h whatever happens
- RunPod's account spend limit and low-balance notifications (billing page)

**Admin API** (`aro-admin`):
- `costs { days }` returns spend per day, per model and served-by, the heaviest users, cache hits and alerts.
- `updateCostSettings { patch }` changes the budget and rates.
- `upsertPlan` now also takes `requests_per_minute`, `requests_per_hour`, `max_output_tokens`, `agent_max_steps` and `agent_max_tokens`.

**Langfuse, Helicone and OpenTelemetry are deferred.** `aro_usage_events` already holds what those tools would show for cost: tokens, latency and cost per trace and per user. It lives in our own database, with no prompt contents leaving it. A hosted tracer would receive prompts and answers too, which needs a privacy review and a data processing agreement first. If you want one later, export `aro_usage_events` (or add an OpenTelemetry exporter in `logUsage`), keyed by the same `trace_id`.

## What you set once

- Supabase secrets:
  - `ARO_MODEL_BASE_URL = https://api.runpod.ai/v2/21xvi4emhujk1r/openai/v1`
  - `ARO_MODEL_API_KEY` = a RunPod API key restricted to the `aro-models` endpoint
  - optionally `ARO_ALERT_WEBHOOK_URL` (a Slack or Discord webhook)
- `ARO_CONTEXT_TOKENS`: leave it unset (32768) unless you change the endpoint's `MAX_MODEL_LEN`; the two must match.
- Budget: set `daily_budget_usd` and `hard_budget_usd` to what you're willing to spend.
