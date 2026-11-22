# The seven ARO models

ARO AI's product catalogue is exactly seven models. New features become **capabilities inside these models**, not new models. The machine-readable source of truth is [`models/catalog.json`](../models/catalog.json); plans and prices start from [`models/plans.json`](../models/plans.json) and are then edited in the admin dashboard.

| Model | What it covers | How it's built | Status today |
|---|---|---|---|
| **ARO 1.5** | General intelligence: conversation, writing, knowledge, reasoning, planning, tool use | LoRA adapter on the shared foundation | Live once the model server runs |
| **ARO Code** | Code generation, debugging, review, architecture, tests, repo understanding (powers the Code tab agent) | LoRA adapter on the shared foundation | Preview (answers through ARO 1.5 until its adapter is published) |
| **ARO Research** | Maths, science, advanced reasoning, research and academic writing | LoRA adapter on the shared foundation; thinking on by default | Preview |
| **ARO Translate** | Translation and African-language intelligence | LoRA adapter on the shared foundation | Preview |
| **ARO Vision** | Image and document understanding, OCR, visual Q&A | Specialist vision-language model on its own server | Planned (server and routing are built; needs a GPU server) |
| **ARO Voice** | Speech-to-text, text-to-speech, voice conversations | Specialist speech models | Planned (catalogue, plans and credits only) |
| **ARO Creative** | Image, video and music generation; creative writing | Specialist generation models, credit-billed | Planned (catalogue, plans and credits only) |

An admin can change any model's status in the dashboard. `planned` and `disabled` models are refused by the server for everyone.

## Shared foundation, specialist adapters

ARO 1.5, Code, Research and Translate are **one base model with four small LoRA adapters**. vLLM loads the base once and serves each adapter under its own name (`aro-1.5`, `aro-code`, …). One GPU serves four specialists, and each specialist trains and versions independently.

- **Base model:** `Qwen/Qwen3-4B`, Apache-2.0. A free Colab T4 can fine-tune it. The upgrade path is `Qwen/Qwen3-8B` (also Apache-2.0) once production has a 24 GB GPU.
- **Unpublished specialists:** if a specialist's adapter isn't published yet, the server answers with ARO 1.5 under the specialist's instructions. The answer is recorded as ARO 1.5's, so training data goes to the model that actually produced it.

Vision, Voice and Creative need different architectures, so they are separate specialist models:

| Model | Component | Chosen model | License |
|---|---|---|---|
| ARO Vision | vision-language | `Qwen/Qwen3-VL-4B-Instruct` (later `Qwen3-VL-8B`) | Apache-2.0 |
| ARO Voice | speech-to-text | `openai/whisper-large-v3-turbo` | MIT |
| ARO Voice | text-to-speech | `hexgrad/Kokoro-82M` | Apache-2.0 |
| ARO Creative | images | `black-forest-labs/FLUX.1-schnell` (gated: accept terms) | Apache-2.0 |
| ARO Creative | video | `Wan-AI/Wan2.1-T2V-1.3B` | Apache-2.0 |
| ARO Creative | music | `ACE-Step/ACE-Step-v1-3.5B` | Apache-2.0 |
| ARO Translate | baseline to beat | `google/madlad400-3b-mt` | Apache-2.0 |

**Known gap:** Kokoro has no African-language voices yet. The obvious alternative, Meta's MMS-TTS, is non-commercial (see below). African text-to-speech needs our own training on permissively licensed recordings.

### Rejected because of their licenses

All licenses below were read from each model's Hugging Face page on 2026-11-22.

| Model | License | Why not |
|---|---|---|
| `facebook/nllb-200-distilled-600M` | CC-BY-NC-4.0 | Non-commercial. Research comparison only. |
| `facebook/mms-tts-hau`, `facebook/mms-1b-all` | CC-BY-NC-4.0 | Non-commercial. |
| `facebook/musicgen-small` | CC-BY-NC-4.0 | Non-commercial. |
| `black-forest-labs/FLUX.1-dev` | FLUX.1-dev license | Non-commercial. |
| `stabilityai/stable-audio-open-1.0` | Stability community license | Revenue cap; needs legal review. |
| `Lightricks/LTX-Video` | Custom | Needs legal review. |
| `stabilityai/stable-diffusion-xl-base-1.0` | OpenRAIL++ | Allowed with use restrictions. Kept as a fallback only. |
| `Qwen/Qwen2.5-VL-3B-Instruct`, `Qwen/Qwen2.5-3B` | Qwen research license | Not cleared for commercial use. |

## Central model router

The router is in `supabase/functions/_shared/aro.ts`. When a user picks **ARO (Auto)**, it sends:

- requests with images to **Vision**
- translation requests to **Translate**
- code questions to **Code**
- maths and science questions to **Research**
- everything else to **ARO 1.5**

The routing rules are simple, readable regular expressions, and they are unit-tested.

Before any model is called, the server checks the user's access in Postgres (`aro_authorize`):
- **The user chose a model directly:** they get a clear refusal: 402 if it isn't in their plan, 429 if the daily limit is used up.
- **The user chose Auto:** they never get refused. ARO 1.5 answers instead, and the app explains why.

If the model fails before answering, the request is refunded.

## Data

[`training/aro_data/DATASETS.md`](../training/aro_data/DATASETS.md) is generated from the dataset registry. It covers every dataset in the brief, plus SMOL, Aya, AfriMGSM and others found during research, each with its license status. Main rules:

- **Only datasets cleared for commercial training can be trained on.** That means a recorded license check, commercial status `allowed`, and assignment to the model. A license gate in code enforces this.
- **Benchmarks are evaluation-only, and retrieval sources are RAG-only.** These two groups never enter training data.
- **Notable exclusions:**
  - non-commercial: No Robots, MAFAND, ImageNet, HausaVG
  - withdrawn: MATH, WebVid, LAION
  - generated by models whose terms forbid training competitors: UltraChat, NuminaMath-CoT, parts of Tulu 3
- **African languages:**
  - Google **SMOL** (CC-BY-4.0): professional translations for Hausa, Yoruba, Igbo, Nigerian Pidgin, Fulfulde, Swahili, Amharic, Wolof, Zulu, Xhosa and Arabic. This is ARO Translate's main training source.
  - **Aya** (Apache-2.0): human-written conversations in Hausa, Igbo, Yoruba, Swahili, Amharic, Wolof, Xhosa and Zulu.
- **User feedback:** used only from users who opted in, and only for answers that ARO itself gave.

## Quality gate

Every text model has a fixed test set in `training/eval/<model>.jsonl` (15–25 items, including identity and safety items marked *critical*). A new version is published only if:

1. it scores higher than the current version by at least the margin, and
2. it fails no critical item that the current version passes.

Each run records:
- per-category scores
- mean and p95 latency
- tokens per second
- critical failures

These go to `training/results/leaderboard.jsonl` and to the admin dashboard's Evaluations tab. Public benchmarks (HumanEval, MBPP, FLORES+, Belebele, AfriXNLI, AfriMGSM) are listed in the registry as evaluation-only data. They aren't wired into the test runs yet, so they're the next addition to the test sets.

## Roadmap

1. **Now:** train ARO 1.5, Code, Research and Translate on Colab, and serve them from one GPU.
2. **ARO Vision:** deploy `Qwen3-VL-4B-Instruct` with vLLM on a second GPU, set `ARO_VISION_BASE_URL`, and switch the model to `live` in the dashboard.
3. **ARO Voice:**
   - add an Edge Function in front of vLLM's speech-to-text endpoint (Whisper) and a Kokoro server
   - fine-tune Whisper on Common Voice and FLEURS for Hausa, Yoruba and Igbo
4. **ARO Creative:** a credit-billed generation service (FLUX.1-schnell, then Wan2.1 and ACE-Step) behind the same entitlement check.
5. **Payments:** connect Paystack or Stripe webhooks to the existing `aro_admin_grant_plan`, `aro_admin_grant_model` and `aro_admin_add_credits` functions.
6. **Before a public commercial launch:** have a lawyer review the dataset and model licenses listed here.
