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
| Strict RAG | No vector database or knowledge graph. Grounding exists only as: web search when requested (`_shared/web.ts`), and a static verified reference for Nigerian languages (`_shared/languages.ts`), injected by keyword. The **Knowledge Base screen is a placeholder** that stores nothing. `pgvector` is available in Supabase but not installed. | ❌ |
| Citation enforcement | The web mode tells the model to cite `[n]` and appends a Sources list. Nothing checks that the cited numbers exist or that claims match the sources. There is no retrieval confidence and no "not enough verified data" fallback. | 🟡 |
| Deterministic tools | Chat has **no tools**: ARO does maths and dates in text. The agent has repository and web tools, but no calculator, date or SQL tool. | ❌ |

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
| Short-term | Chat: `fitToContext` **drops** the oldest messages at the context limit. Agent: `compactTranscript` shortens old tool output and drops old exchanges. No summarisation, and no 70% trigger. | 🟡 |
| Long-term semantic | None. Conversations are stored in Firestore, but nothing is remembered across chats (preferences, facts, rules). | ❌ |
| Episodic / procedural | 👍/👎 ratings and corrections are stored, but used only **offline for training**. The agent keeps no log of its failures, and nothing is checked before a task. | ❌ |

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
| Plan-and-solve | The agent goes straight into tool calls. The system prompt says "explore first", but nothing enforces it. | ❌ |
| Evaluator-optimizer | No critic at runtime. The **offline** quality gate (`evaluate.py`) stops weaker *model versions*, not weak *answers*. | ❌ |

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
| Graph orchestration | A **bounded loop** (step, token and time caps from the plan; a breaker for repeated identical calls; pause and *Continue*). It is still an open loop with no explicit states, entry or exit conditions, or retry policy. | 🟡 |
| Persistent checkpoints | The state is returned to the app at the end of each request and saved in Firestore. If the function is killed mid-run, that run's progress is lost (pushed commits survive on GitHub). | 🟡 |
| Human-in-the-loop | Direct push to the main branch requires an explicit opt-in with a warning. The default is a working branch plus a pull request, which is itself a review gate. There is no per-action confirmation for deleting files, mass edits or opening PRs. | 🟡 |

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
| Strict structured outputs | Tool parameters are declared as JSON Schema, but arguments are hand-checked per tool (`requireString`) and invalid JSON is passed through. SSE frames and agent state are ad hoc objects. The database calls are typed and validated in SQL. | 🟡 |

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
| **1. Foundation** | Agent state machine + Postgres checkpoints + confirmation gates · strict schema validation of tool calls (+ guided JSON for ARO) · deterministic `calculate` / `date_math` tools for the agent and chat | Everything else (plans, critics, sandbox steps, retries) plugs into the state machine. Schemas stop malformed calls today. Calculator and date tools remove a whole class of hallucination cheaply. | M |
| **2. Plan and critique** | JSON plan step (shown to the user; it becomes the step list) · critic before commit and for long code answers · episodic log of agent failures and corrections, checked before runs | Needs the Phase 1 state machine. It turns the agent from act-first into plan → act → check. | M |
| **3. Knowledge and memory** | `pgvector` + `pg_trgm` knowledge store · real Knowledge Base (upload, chunk, embed) · strict-RAG router with confidence threshold · citation verifier · rolling summaries at 70% · long-term `memories` with consent | The largest piece, and it needs product decisions: which domains count as "ours", and the memory consent design. | L |
| **4. Real execution** | Sandbox runner (RunPod CPU serverless) + `run_in_sandbox` · tests run in `VERIFY_STEP` before commit · Python for heavy data and maths | Needs infrastructure and a vendor or isolation decision. Plugs into the Phase 1 state machine. | M–L |

## Decisions needed

1. **Strict-RAG domains:** which questions must be answered only from your data? Proposed: ARO product and support, the user's own Knowledge Base documents, and verified language facts. General questions keep using the model and web search.
2. **Sandbox:** a RunPod Serverless CPU endpoint (self-run, no new vendor; pay per second) or a hosted sandbox such as E2B (stronger isolation out of the box; new vendor and key).
3. **Long-term memory:** opt-in or on by default, with a visible "What ARO remembers" page in Settings either way.
4. **Embedding model:** `BAAI/bge-m3` (MIT, multilingual) on the existing RunPod setup, after the Data Engine license check.
