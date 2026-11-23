# Agent reliability: architecture review and roadmap

This review checks ARO's engine against five guardrail patterns: grounding, memory, plan and critique, long-horizon orchestration, and real-world feedback with strict schemas. For each pattern it records what exists today, the gap, and the order to build in. It's based on the code as of 2026-11-24.

**The engine today:**
- `ai-router`: streaming chat. It has no tools of its own.
- `aro-agent`: a GitHub coding agent with repository and web tools.
- Supabase Postgres (entitlements, usage, cost), Firestore (conversations, feedback, agent sessions), RunPod Serverless vLLM (ARO 1.5, Qwen3-4B with LoRA).

**Constraints that shape the design:**
- **Edge Functions** (Deno) stop after 150–400 s of wall time and cannot run Docker or subprocesses, so a code sandbox must be a separate service.
- **ARO 1.5 is a 4B model.** It follows long instructions poorly (the Hausa audit showed this). Guardrails must therefore be enforced by code, using vLLM guided decoding, validators and state machines, not by prompts.
- **Every extra model pass costs GPU seconds.** Planners and critics are applied selectively and stay within the existing cost guardrails (`docs/COSTS.md`).

Status: ✅ in place · 🟡 partial · ❌ missing

## 1. Grounding and verification

| Pattern | Today | Status |
|---|---|---|
| Strict RAG | **Phase 3 (done):** a real Knowledge Base. Upload PDF (text layer), Word .docx, text, Markdown, CSV, JSON or code, or paste text (`aro-knowledge`). Documents are split into ~1,800-character passages with overlap (`aro_kb_documents` / `aro_kb_chunks`, per user, service_role only). Search is hybrid: keyword search (`'simple'` text search, so Hausa, Yoruba and Igbo letters work) plus `pg_trgm`, plus `pgvector` bge-m3 vectors when `EMBEDDINGS_BASE_URL` is set, fused with reciprocal-rank fusion. A **confidence threshold** (query-word coverage, or cosine ≥ 0.5) decides what reaches the model; unrelated questions get no passages. With **"Docs only"** on and nothing relevant found, there is no model call and no charge, and ARO says it couldn't find it instead of guessing. **Still open:** global ARO product and support knowledge; embeddings stay keyword-only until an embedding endpoint is deployed. | 🟡 |
| Citation enforcement | **Phase 3 (done for the Knowledge Base):** passages are labelled `[K1]…`, and after the answer `verifyCitations` checks that every cited label exists and that the citing sentence's key words appear in that passage. In Docs-only mode an answer that cites nothing is flagged. Problems are shown under the answer, followed by a "From your documents" list. Web mode still only lists its sources. | 🟡 |
| Deterministic tools | **Phase 1 (done):** `calculate` and `date_math` for the agent and chat. `query_data` (read-only SQL over the user's data) is not built. | 🟡 |

**What to build:**
- **Knowledge store:** Postgres + `pgvector` + `pg_trgm` hybrid search. Tables `kb_sources`, `kb_chunks(embedding vector, tsv, …)`, with row ownership: global ARO knowledge (product, plans, language facts) plus each user's own documents. This makes the Knowledge Base screen real.
- **Embeddings:** a small, permissively licensed multilingual embedding model on the existing RunPod serverless setup (candidate: `BAAI/bge-m3`, MIT; it must pass the Data Engine license check). Keyword search through `pg_trgm` works from day one without it.
- **Strict-RAG router** in `ai-router`:
  - **When it applies:** a question in a covered domain (ARO product and support, the user's own documents, Nigerian-language facts).
  - **What happens:** it retrieves first, and the model answers only from the retrieved chunks, each tagged `[S1]`, `[S2]` and so on.
  - **Below the confidence threshold:** if the best score is below the threshold, there is no model call. The reply is "I don't have enough verified data on this", with an offer to search the web.
  - **Other questions:** open-domain questions keep their current behaviour (the model, or web search when asked).
- **Citation verifier:** after generation, check that every `[S#]` or `[n]` exists and every quoted span appears in its chunk. Drop or flag sentences that fail, and show the verification status in the meta frame.
- **Deterministic tools** for chat and the agent:
  - `calculate`: a safe expression evaluator, never `eval`
  - `date_math`: calendar and timezone logic
  - `query_data`: parameterised, read-only SQL over the user's own data through a Postgres function

  Maths and date questions are detected and routed to these tools, and the model only explains the result.

## 2. Memory (three tiers)

| Tier | Today | Status |
|---|---|---|
| Short-term | **Phase 3 (chat on ARO, done):** past 70% of ARO's input budget, the oldest messages are condensed into a summary instead of being dropped (`_shared/summary.ts`). Summaries are made in blocks of 8 messages and stored by a hash of the prefix they cover (`aro_conversation_summaries`, 30 days), so each block is summarised once and later turns reuse it. `fitToContext` remains as the safety net. Bring-your-own-key models have large windows and aren't summarised. **Still open:** the agent transcript still uses `compactTranscript`. | 🟡 |
| Long-term semantic | **Phase 3 (done):** opt-in memory, **off by default** (`aro_memories`, `aro_memory_settings`). When on: "remember that…" / "from now on…" saves, and "forget…" deletes. Durable facts the user states about themselves (name, work, language, answer preferences, standing rules) are extracted by one small call from the user's own words only, never documents, web pages or answers. Sensitive categories are excluded, and near-duplicates are skipped. Each turn gets the newest rules and preferences plus the entries that match the message. Settings → Memory shows every entry with delete and delete-all. Answers that use memory are never cached. | ✅ |
| Episodic / procedural | **Phase 2 (agent, done):** `aro_agent_episodes` (per user and repository, service_role only, RLS on) logs declined actions with the user's reason, commits held back by review, loops, and failed runs. The newest 8 are put in the agent's system prompt at the start of every run on that repository. The newest 50 per repository are kept, for 90 days at most. **Still open:** CI failures after a push, chat 👎 corrections, and similarity search (Phase 3, with embeddings). | 🟡 |

**What to build:**
- **Rolling summary:** at about 70% of the model's context, summarise the oldest turns into a pinned "conversation so far" message, kept in the conversation document so it's computed once. Same for the agent transcript, replacing truncation with a summary of earlier steps.
- **`memories` table** (pgvector, per user):
  - **Writes:** extracted from conversations (preferences, stable facts, rules) only with the user's consent.
  - **User control:** visible and deletable in Settings.
  - **Reads:** the top-k are retrieved into the system prompt each turn.
- **`episodes` table:**
  - **What goes in:** agent run outcomes (failures, reverted changes, CI failures after a push) and user corrections (👎 with a correction).
  - **When it's read:** before an agent run, or a chat on the same topic, the most similar episodes are retrieved as "past mistakes to avoid".

## 3. Reasoning: plan and self-critique

| Pattern | Today | Status |
|---|---|---|
| Plan-and-solve | **Phase 2 (done):** the agent explores freely, then must call `set_plan` (goal + up to 12 steps, schema-validated) before any change: `write_file`, `edit_file`, `delete_file`, `commit_and_push` and `create_pull_request` are refused until a plan exists for the current request. A new user message makes the plan stale until it is updated. The plan is repeated in the system prompt every turn, and the app shows it as a live checklist. A model that never plans gets a minimal plan from the task after 2 refusals, so the run never stalls. | ✅ |
| Evaluator-optimizer | **Phase 2 (done):** before `commit_and_push` runs, a fresh-context reviewer (same model, strict rubric in `_shared/review.ts`) sees the request, the plan and the real unified diff (`_shared/diff.ts`), and answers through a schema-validated `submit_review`. Blocking problems hold the commit back and go to the agent to fix, for up to 2 rounds, then it may commit with the notes attached. Minor notes are passed on. A reviewer that errors never blocks. In chat, answers with 30+ lines of code get the same second check, and its findings are appended under the answer; answers with findings are not cached. The **offline** quality gate (`evaluate.py`) still guards model versions. **Limit:** a 4B reviewer catches obvious flaws only. | ✅ |

**What to build:**
- **Planning step** in the agent before any tool runs:
  - **Plan format:** a JSON execution plan, `{goal, steps:[{id, action, tool?, success_check}], risks, needs_confirmation}`, enforced with vLLM guided decoding for ARO and JSON-schema output for bring-your-own-key models.
  - **Display:** the plan is shown to the user and becomes the state machine's step list (pattern 4).
- **Critic** for critical outputs: code diffs before `commit_and_push`, multi-step analyses, and long code answers in chat.
  - **The rubric:** correctness, matches the plan, no secrets, tests considered, no invented APIs.
  - **On failure:** one revision round, then the result goes out with the critic's concerns attached.
  - **Who reviews:** the same model with a strict rubric by default. The user's stronger model can be used when they have one.
  - **Limit:** a 4B critic catches obvious flaws only. Its value is bounded until ARO 2.0.

## 4. Long-horizon tasks: state machine and checkpoints

| Pattern | Today | Status |
|---|---|---|
| Graph orchestration | **Phase 1 (done):** an explicit state machine in `aro-agent/handler.ts`: `resolve_confirmation → model → tools →` `completed` \| `paused` \| `awaiting_confirmation` \| `failed`. Transient model errors retry 3 times with backoff (1 s, 2 s, 4 s); 3 consecutive all-invalid tool batches end the run as `failed` with a report. The step, token and time caps and the repeated-call breaker still apply. Plan, verify and critique states come in Phases 2 and 4. | ✅ |
| Persistent checkpoints | **Phase 1 (done):** the state is saved to Postgres (`aro_agent_checkpoints`, service_role only, RLS on) after every step, and the app keeps its copy. On *Continue* the newer checkpoint wins, so a run killed mid-way resumes from its last step. Another user can't load it. Checkpoints are kept 30 days. | ✅ |
| Human-in-the-loop | **Phase 1 (done):** the run stops in `awaiting_confirmation` with a summary of exactly what will happen before: opening a pull request; a direct push to the base branch; deleting files; touching CI, env, secrets, infra or migrations; or changing more than 20 files. The app shows **Approve / Decline**. Declining, or typing a new message, tells the model the step was not approved, and calls after it in the same batch are not run. | ✅ |

**What to build:**
- **Explicit state machine** in `aro-agent`:
  - **States:** `PLAN → (CONFIRM_PLAN) → EXECUTE_STEP → VERIFY_STEP → CRITIQUE → (CONFIRM_ACTION) → COMMIT → DONE | FAILED | ESCALATED`
  - **Transitions:** each state has entry and exit conditions and a per-state retry limit (3). After that the run ends gracefully with a report, never an open loop.
  - **Implementation:** a small custom engine in TypeScript. LangGraph doesn't run in Deno Edge Functions.
- **Checkpoints:** an `agent_runs` / `agent_checkpoints` table in Postgres, written after every tool call (state, step index, staged edits, transcript summary). *Continue* resumes from the last checkpoint even if the app never received the final state.
- **Confirmation gates:**
  - **When:** a tool policy marks actions as `confirm`: deleting files, pushing to the base branch, changing more than N files, workflows/CI or secrets files, opening or merging PRs.
  - **How:** the run pauses in a `CONFIRM_ACTION` state with a summary of exactly what will happen, and resumes only after an explicit approval from the app.

## 5. Real-world feedback and strict schemas

| Pattern | Today | Status |
|---|---|---|
| Sandbox execution | None. The agent says it "cannot run code". Its only real feedback is `get_ci_status` **after** pushing. | ❌ |
| Strict structured outputs | **Phase 1 (done):** every tool call is validated against its JSON Schema (`_shared/schema.ts`; `additionalProperties: false`, types, enums, lengths, patterns) before it runs. Invalid calls and unparseable JSON are never executed: the model gets the exact errors back. Agent state is normalised by `parseState`. **Still open:** vLLM guided decoding for ARO tool calls, and typed SSE frames. | 🟡 |
| Deterministic maths and dates | **Phase 1 (done):** `calculate` (an exact parser with no `eval`: + − × ÷ ^ %, `of`, factorial, sqrt/log/trig/round…) and `date_math` (today in any timezone, add, diff, weekday). The agent has both as tools. In chat, `ai-router` evaluates a bare expression directly; for word problems it runs a short tool pass (3 rounds at most) before answering. The verified values go to the model, which explains them instead of computing. Date answers are never cached. | ✅ |

**What to build:**
- **Sandbox service:**
  - **Where:** a separate isolated runner. Recommended: a **RunPod Serverless CPU endpoint**, one container per job, with no secrets, a CPU, memory and time limit, the repository checked out at the working branch, and outbound network limited to package registries. The alternative is a hosted sandbox (e.g. E2B), which needs a vendor account and a key.
  - **Tool:** `run_in_sandbox(command)` returns the real exit code, stdout and stderr.
  - **When it's used:** in the state machine's `VERIFY_STEP` (run tests or a linter) before commit. The same runner backs `calculate` for heavy maths and Python data work.
- **Schemas everywhere:**
  - **Tool arguments:** each tool's JSON Schema is validated with a real validator before execution. Invalid calls go back to the model as a structured error (at most 2 retries), never executed.
  - **ARO tool calls:** vLLM guided decoding forces valid JSON.
  - **Internal frames and state:** typed and validated (agent state, SSE frames, plan and critic outputs).
  - **Python side:** the training and evaluation side already uses typed dataclasses; add Pydantic where data crosses process boundaries.

## Order of work

Each phase builds on the one before and ships independently, with tests.

| Phase | Build | Why first | Size |
|---|---|---|---|
| **1. Foundation** ✅ (guided JSON still open) | Agent state machine + Postgres checkpoints + confirmation gates · strict schema validation of tool calls (+ guided JSON for ARO) · deterministic `calculate` / `date_math` tools for the agent and chat | Everything else (plans, critics, sandbox steps, retries) plugs into the state machine. Schemas stop malformed calls today. Calculator and date tools remove a whole class of hallucination cheaply. | M |
| **2. Plan and critique** ✅ (similarity search for episodes moves to Phase 3) | JSON plan step (shown to the user; it becomes the step list) · critic before commit and for long code answers · episodic log of agent failures and corrections, checked before runs | Needs the Phase 1 state machine. It turns the agent from act-first into plan → act → check. | M |
| **3. Knowledge and memory** ✅ (embedding endpoint and global product knowledge still open) | `pgvector` + `pg_trgm` knowledge store · real Knowledge Base (upload, chunk, embed) · strict-RAG router with confidence threshold · citation verifier · rolling summaries at 70% · long-term `memories` with consent | The largest piece, and it needs product decisions: which domains count as "ours", and the memory consent design. | L |
| **4. Real execution** | Sandbox runner (RunPod CPU serverless) + `run_in_sandbox` · tests run in `VERIFY_STEP` before commit · Python for heavy data and maths | Needs infrastructure and a vendor or isolation decision. Plugs into the Phase 1 state machine. | M–L |

## Decisions

1. **Strict-RAG domains:** decided for Phase 3: the user's own Knowledge Base documents, on demand ("Docs only"). ARO product and support knowledge is still open.
2. **Sandbox:** a RunPod Serverless CPU endpoint (self-run, no new vendor; pay per second) or a hosted sandbox such as E2B (stronger isolation out of the box; new vendor and key).
3. **Long-term memory:** decided: opt-in (off by default), with Settings → Memory.
4. **Embedding model:** `BAAI/bge-m3` (MIT, multilingual). It needs its own scale-to-zero RunPod endpoint: one vLLM worker serves one model, so the ARO 1.5 endpoint can't serve it too. Set `EMBEDDINGS_BASE_URL` (and `EMBEDDINGS_API_KEY`) in Supabase once it exists. Documents added before that stay keyword-searchable.
