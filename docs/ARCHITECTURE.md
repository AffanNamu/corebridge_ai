# ARO AI architecture

```
 Flutter app / Next.js web
   │  Firebase Auth (sign-in) ── ID token on every Edge Function call
   │  Firestore (owner-only rules)
   │    users/{uid}                 profile, provider keys, GitHub token, trainingConsent
   │    conversations/{id}/items    messages: servedBy, model, rating, correction
   │    agentSessions/{id}          GitHub agent tasks: timeline + resumable state
   │    artifacts, files, projects
   ▼
 Supabase Edge Functions ─────────────── Supabase Postgres (service role only, RLS locked)
   ├─ ai-router   chat (SSE) + plan overview      aro_models, aro_plans, aro_plan_models,
   │    ├─ aro ──► model router (_shared/aro.ts)   aro_user_plans, aro_user_model_grants,
   │    │     ├─ aro_authorize (plan/credits) ◄──  aro_credit_balances/ledger, aro_usage_daily,
   │    │     ├─ text models ─► vLLM: base + LoRA  model_evaluations, aro_admin_audit
   │    │     │   (aro-1.5, aro-code, aro-research, aro-translate)
   │    │     ├─ aro-vision ─► vision server (Qwen3-VL)
   │    │     └─ backup model while the ARO server is offline
   │    └─ claude / openai / gemini / qwen ──► provider API with the user's key
   ├─ aro-agent   GitHub coding agent (SSE) — runs on ARO 1.5 (coding capability) or a BYOK model
   ├─ aro-admin   admin dashboard API (ADMIN_UIDS only, every change audited)
   ├─ file-process    Storage → Cloudinary
   └─ export-artifact md / pdf / docx / zip
                     ▲
 training/ (GPU) ────┘ Data Engine (license gate) → prepare → train → evaluate → publish
   adapters to private Hugging Face repos; evaluation results → model_evaluations
```

## Plans and entitlements

Paid access is decided **only on the server**:

1. Every ARO request calls `aro_authorize(user, model)` in Postgres. That one atomic function checks the user's plan, or any individually purchased model, against today's limit. Otherwise it charges credits, and otherwise it refuses.
2. Concurrent requests are serialised with a row lock, so two requests at once can't both get past a limit.
3. All entitlement tables have RLS on and no policies, and all functions are executable by `service_role` only. The anon and authenticated keys in the app can't read or change them.
4. When no model answered, `aro_refund` gives the request (or credits) back.

**Admins:** admin actions go through `aro_admin_*` functions, each of which writes to `aro_admin_audit`. Admins are the Firebase UIDs in the `ADMIN_UIDS` secret.

**Payments (not wired yet):** a payment webhook (Paystack or Stripe) will call the same grant functions with `p_admin = 'payments:<provider>'`.

The default catalogue and plans come from `models/catalog.json` and `models/plans.json` through a generated seed migration. The seed never overwrites changes made in the dashboard.

## Chat: `ai-router`

- **Input:** `provider`, `model`, `messages` (text, or text and base64 images), `apiKey` (BYOK providers only) and `thinkingEnabled`.
- **Output:** SSE frames, in this order:
  - `{"meta": {"servedBy", "model"}}`
  - then `{"thinking"}` and `{"delta"}` frames
  - an `{"error"}` frame if something fails
  - finally `[DONE]`
- **ARO:**
  - `model` is an ARO model id or `auto`. The router (`_shared/aro.ts`) picks the specialist, checks the plan, and adds that model's system prompt from the database.
  - Endpoints are tried in order:
    1. the model on its server
    2. ARO 1.5 on the same server, if the specialist's adapter isn't published yet
    3. the `ARO_FALLBACK_*` backup
  - It never switches models partway through an answer.
  - Explicit choices that aren't allowed get 402 or 429 with a message the app shows as-is. Auto falls back to ARO 1.5 and explains why in `meta.notice`.
- **Who answered:** `servedBy` and `model` record which model actually answered, and the app saves them on the message. Only `servedBy == "aro"` answers can ever become training data, and only for the ARO model that produced them.
- **overview:** `action: "overview"` returns the user's plan, credits, each model's status and today's usage, the plans, products and credit packs, and whether the user is an admin.
- **listModels:** `action: "listModels"` returns the models a user's key can use, best first. Qwen also gets a separate vision list.

## GitHub coding agent: `aro-agent`

**Connecting.** The user connects a fine-grained personal access token (Contents and Pull requests: read and write). Everything runs with that token, so the agent can't reach anything the user can't.

**How a run works:**
1. The model gets these tools: `list_files`, `read_file`, `search_code`, `write_file`, `edit_file`, `delete_file`, `commit_and_push`, `create_pull_request` and `get_ci_status`.
2. Edits are staged in the session, then pushed as one commit using GitHub's Git Data API (blobs → tree → commit → fast-forward ref, never a force push).
3. By default commits go to a new `aro/<task>-<id>` branch and the agent opens a pull request. Pushing straight to the base branch is a per-task switch that asks for confirmation.
4. Commits that look like they contain secrets (private keys, API keys, tokens, `.env`, keystores) are refused.

**Stateless and resumable.** The function returns `state` (transcript, staged edits, branch, commits) and the app stores it in `agentSessions`. A run pauses after about 110 seconds or 25 steps, under the Edge Function limit, and **Continue** resumes it from the stored state.

**Models.** It works with ARO (vLLM tool calling), Claude (Messages API tools) and OpenAI, Qwen or Gemini (Chat Completions tools; Gemini uses its OpenAI-compatible endpoint). Provider-specific data in tool calls, such as Gemini thought signatures and Claude thinking blocks, is replayed exactly as it came back.

## ARO models and the training loop

ARO's generations, capabilities, base models and licenses are in [MODELS.md](MODELS.md). The ARO 1.5 capabilities' training loop:

The full details are in [training/README.md](../training/README.md).

1. **Opt in.** In Settings → *Help improve ARO* (`users/{uid}.trainingConsent`), the user agrees to share their ARO chats. They rate answers 👍/👎 and can write a better answer.
2. **prepare** builds each text model's training set:
   - only datasets that pass the Data Engine's license gate (`training/aro_data`)
   - only opted-in users, and only rated answers that model gave, plus corrections
   - personal data and secrets scrubbed
   - duplicates and anything overlapping the model's test set removed
   - older data mixed back in
   - a provenance manifest with checksums
3. **train:** a QLoRA fine-tune of Qwen3-4B, one LoRA adapter per model. **evaluate:** compares the new version with the current one on that model's fixed test set, recording scores, latency and tokens/s.
4. **promote:** if the new version is better, it is published to that model's private Hugging Face repo, with a one-step rollback. One vLLM server then serves all four adapters.

## Costs

Rate limits, prompt and response caching, agent caps, scale-to-zero serving, the GPU budget with alerts and per-request cost traces are described in [COSTS.md](COSTS.md).

## Web search

When a user taps **Web**, or writes things like "search online", "look it up" or "don't use your training", ai-router searches the web (Tavily, Brave or Serper with a key, otherwise DuckDuckGo then Wikipedia), reads the top pages, and adds them to the model's instructions. The answer cites them as [1], [2] … and a Sources list with links is appended. The coding agent has `web_search` and `read_webpage` tools for docs and error fixes. Pages are read only from public addresses (private, local and metadata addresses are refused, including after redirects), and page text is treated as information, never as instructions. ARO's training data includes examples of answering from web results (`training/seed/web_grounded.jsonl`).

## Reliability roadmap

How the engine measures up against grounding, memory, plan-and-critique, state-machine orchestration and sandboxed execution, and the order of work: [AGENT_RELIABILITY.md](AGENT_RELIABILITY.md).
