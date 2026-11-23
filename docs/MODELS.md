# ARO: one model family, released in generations

**ARO is one AI model family, developed by ARO Group.** It is released in **generations**: ARO 1.5 today, then ARO 2.0, 3.0, 4.0 and so on. Each generation has its own version identity, intelligence level, configuration and roadmap, and it must be measurably better than the one before it.

Coding, research, translation and the planned vision, voice and media abilities are **capabilities of the ARO assistant**, not separate AI products. Whatever capability is active, ARO introduces itself as the generation it runs on, for example "ARO 1.5, developed by ARO Group".

The machine-readable source of truth is [`models/catalog.json`](../models/catalog.json):
- `family`: the name, developer and current generation
- `generations`: each generation's description, intelligence level, configuration, capabilities and roadmap
- `models`: the capability entries the product exposes

Plans and prices start from [`models/plans.json`](../models/plans.json) and are then edited in the admin dashboard.

## Generations

| Generation | Status | What it is |
|---|---|---|
| **ARO 1.5** | **Current** | Compact text model (about 4B parameters, `Qwen/Qwen3-4B` foundation, Apache-2.0) adapted by ARO Group with LoRA capability adapters. 32k-token context. Good for everyday questions, writing, coding help and step-by-step maths; not a frontier-scale model. |
| **ARO 2.0** | Planned, not available | Next generation. Goals: a larger, license-checked foundation; capability adapters that pass the quality gate; evaluating image understanding. Must beat ARO 1.5 on every capability's test set. |
| **ARO 3.0** | Planned, not available | Scope set after ARO 2.0 ships. Candidate goals: speech, deeper African-language ability, tool use as a trained skill. |
| **ARO 4.0** | Planned, not available | Exploratory. Candidate goals: media generation and broader multimodal ability. |

The goals for 2.0, 3.0 and 4.0 are targets, not capabilities. Nothing here should be presented to users as available until that generation passes its release criteria.

## ARO 1.5 capabilities

| Capability | Id (stable key) | Status in ARO 1.5 |
|---|---|---|
| General: conversation, writing, knowledge, reasoning, planning, tool use | `aro-1.5` | Available |
| Coding: generation, debugging, review; powers the Code tab agent | `aro-code` | Preview: coding instructions on the general weights until a trained adapter passes the quality gate |
| Research: maths, science, advanced reasoning (thinking on by default) | `aro-research` | Preview: trained adapter in use; it beat the general capability on the research test set |
| Translation: with a focus on African languages | `aro-translate` | Preview: translation instructions on the general weights; trained adapters haven't beaten the base model yet |
| Web search: answers from live results with citations | — | Available (server-side search) |
| Coding agent in GitHub repositories | — | Available (tool calling) |

**Planned capabilities, not part of any released generation:** Vision (`aro-vision`, image understanding), Voice (`aro-voice`, speech) and Creative (`aro-creative`, media generation). The server refuses them for everyone until they're built and switched on, and the app labels Vision "coming soon".

**Why the ids stay `aro-code` and so on:** plans, purchases, usage records, served adapter names and the app all use them as keys. They are capability keys, not product names. Users see "ARO 1.5 · Code", "ARO 1.5 · Research" and "ARO 1.5 · Translate".

An admin can change any capability's status in the dashboard. `planned` and `disabled` capabilities are refused by the server for everyone.

## How ARO 1.5 is built

ARO 1.5's general, coding, research and translation capabilities are **one base model with four small LoRA adapters**. vLLM loads the base once and serves each adapter under its capability key (`aro-1.5`, `aro-code`, …). One GPU serves the whole generation, and each capability trains and versions independently. Every adapter is trained to identify itself as ARO 1.5.

- **Base model:** `Qwen/Qwen3-4B`, Apache-2.0. A free Colab T4 can fine-tune it. The upgrade path is `Qwen/Qwen3-8B` (also Apache-2.0) once production has a 24 GB GPU.
- **Capabilities without a published adapter:** the server answers with ARO 1.5's general weights under the capability's instructions. The answer is recorded under the general capability, so training data goes to the weights that actually produced it.

The planned Vision, Voice and Creative capabilities need different architectures. These are the candidate components; they aren't deployed:

| Capability | Component | Candidate model | License |
|---|---|---|---|
| Vision (planned) | vision-language | `Qwen/Qwen3-VL-4B-Instruct` (later `Qwen3-VL-8B`) | Apache-2.0 |
| Voice (planned) | speech-to-text | `openai/whisper-large-v3-turbo` | MIT |
| Voice (planned) | text-to-speech | `hexgrad/Kokoro-82M` | Apache-2.0 |
| Creative (planned) | images | `black-forest-labs/FLUX.1-schnell` (gated: accept terms) | Apache-2.0 |
| Creative (planned) | video | `Wan-AI/Wan2.1-T2V-1.3B` | Apache-2.0 |
| Creative (planned) | music | `ACE-Step/ACE-Step-v1-3.5B` | Apache-2.0 |
| ARO 1.5 · Translate | baseline to beat | `google/madlad400-3b-mt` | Apache-2.0 |

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

## Central router

The router is in `supabase/functions/_shared/aro.ts`. When a user picks **ARO 1.5 (Auto)**, it picks the capability:

- requests with images: **Vision** (planned, so these are refused with a clear message for now)
- translation requests: **translation**
- code questions: **coding**
- maths and science questions: **research**
- everything else: **general**

The routing rules are simple, readable regular expressions, and they are unit-tested.

Before any model is called, the server checks the user's access in Postgres (`aro_authorize`):
- **The user chose a capability directly:** they get a clear refusal: 402 if it isn't in their plan, 429 if the daily limit is used up.
- **The user chose Auto:** they never get refused. ARO 1.5's general capability answers instead, and the app explains why.

If the model fails before answering, the request is refunded.

## Language accuracy (Nigerian languages)

**The audit.** ARO 1.5's foundation model knows little Hausa, Yoruba, Igbo or Fulfulde. An audit on 2026-11-24 found it confidently:
- classifying Hausa as "Niger-Congo, Kordofanian branch". Hausa is **Afroasiatic, Chadic branch**.
- inventing greetings ("Aba!") and words ("Kamalama" for thank you). The real word is **Na gode**.
- misexplaining kai/ke, which are **you (to a man) / you (to a woman)**
- writing made-up Igbo that looped on one word

**The fix, in the existing pipeline:**
1. **Verified reference** (`supabase/functions/_shared/languages.ts`): hand-checked facts for Hausa, Yoruba, Igbo, Fulfulde and Nigerian Pidgin:
   - classification, per Glottolog and Ethnologue
   - writing system
   - everyday greetings, with meanings and replies
   - dialect notes

   When a conversation names one of these languages, or is written in it, ai-router adds the relevant entries to ARO's instructions.
2. **No-invention rules:** sent with the reference, and always with the translation capability:
   - never invent words, translations, greetings, proverbs or etymologies
   - say when unsure, and label any attempt as unverified
   - mention dialect, gender and politeness differences
   - use the borrowed form for technical terms instead of coining one
3. **Full sentences:** for a full-sentence translation *into* Hausa, Yoruba, Igbo or Fulfulde, ARO 1.5 says it can't do that reliably yet. It offers verified phrases and suggests a native speaker, the Web button or another model. Set `ARO_SENTENCE_TRANSLATION_LIMITED` (default `ha,yo,ig,ff`) to an empty value once a trained translation adapter passes the test sets.
4. **Loop guard:**
   - ARO's own server gets a mild repetition penalty
   - any reply that starts repeating one word is stopped, with a note that it's probably unreliable
5. **Training:** `training/seed/language_facts.jsonl` holds the same facts plus honest "I'm not sure" answers, and is included in every ARO 1.5 capability's training data.
6. **Regression tests:** `language-facts` and `language-honesty` items in `training/eval/aro-1.5.jsonl` and `aro-translate.jsonl`. The errors above are critical items, so a new version that brings any of them back can't be promoted. Tests check that the audit's actual wrong answers score 0.

**Adding to the reference:** only add facts you can verify from a reliable source or a native speaker. A wrong "verified" fact is worse than none.

## Data

[`training/aro_data/DATASETS.md`](../training/aro_data/DATASETS.md) is generated from the dataset registry. It covers every dataset in the brief, plus SMOL, Aya, AfriMGSM and others found during research, each with its license status. Main rules:

- **Only datasets cleared for commercial training can be trained on.** That means a recorded license check, commercial status `allowed`, and assignment to the model. A license gate in code enforces this.
- **Benchmarks are evaluation-only, and retrieval sources are RAG-only.** These two groups never enter training data.
- **Notable exclusions:**
  - non-commercial: No Robots, MAFAND, ImageNet, HausaVG
  - withdrawn: MATH, WebVid, LAION
  - generated by models whose terms forbid training competitors: UltraChat, NuminaMath-CoT, parts of Tulu 3
- **African languages:**
  - Google **SMOL** (CC-BY-4.0): professional translations for Hausa, Yoruba, Igbo, Nigerian Pidgin, Fulfulde, Swahili, Amharic, Wolof, Zulu, Xhosa and Arabic. This is the translation capability's main training source.
  - **Aya** (Apache-2.0): human-written conversations in Hausa, Igbo, Yoruba, Swahili, Amharic, Wolof, Xhosa and Zulu.
- **User feedback:** used only from users who opted in, and only for answers that ARO itself gave.

## Quality gate

Every ARO 1.5 capability has a fixed test set in `training/eval/<id>.jsonl` (15–25 items, including identity and safety items marked *critical*). A new version is published only if:

1. it scores higher than the current version by at least the margin, and
2. it fails no critical item that the current version passes.

Each run records:
- per-category scores
- mean and p95 latency
- tokens per second
- critical failures

These go to `training/results/leaderboard.jsonl` and to the admin dashboard's Evaluations tab. Public benchmarks (HumanEval, MBPP, FLORES+, Belebele, AfriXNLI, AfriMGSM) are listed in the registry as evaluation-only data. They aren't wired into the test runs yet, so they're the next addition to the test sets.

## Roadmap

Generation-level goals live in `models/catalog.json → generations`. Near-term steps:

1. **ARO 1.5:** keep improving its capabilities from opted-in feedback. A new adapter goes live only if it passes the quality gate.
2. **Vision capability:** deploy `Qwen3-VL-4B-Instruct` with vLLM on a second GPU, set `ARO_VISION_BASE_URL`, attach it to a generation in the catalogue, and switch it to `live` in the dashboard.
3. **Voice capability:**
   - add an Edge Function in front of a Whisper speech-to-text endpoint and a Kokoro server
   - fine-tune Whisper on Common Voice and FLEURS for Hausa, Yoruba and Igbo
4. **Creative capability:** a credit-billed generation service (FLUX.1-schnell, then Wan2.1 and ACE-Step) behind the same entitlement check.
5. **ARO 2.0:** pick and license-check a larger foundation, retrain the capabilities, and release only if it beats ARO 1.5 everywhere.
6. **Payments:** connect Paystack or Stripe webhooks to the existing `aro_admin_grant_plan`, `aro_admin_grant_model` and `aro_admin_add_credits` functions.
7. **Before a public commercial launch:** have a lawyer review the dataset and model licenses listed here.
