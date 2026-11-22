# ARO AI architecture

```
 Flutter app / Next.js web
   │  Firebase Auth (sign-in) ── ID token on every Edge Function call
   │  Firestore (owner-only rules)
   │    users/{uid}                 profile, provider keys, GitHub token, trainingConsent
   │    conversations/{id}/items    messages: servedBy, rating, correction
   │    agentSessions/{id}          GitHub agent tasks: timeline + resumable state
   │    artifacts, files, projects
   ▼
 Supabase Edge Functions
   ├─ ai-router   chat (SSE)
   │    ├─ aro ──► ARO model server (vLLM, OpenAI-compatible) ──► fallback if offline
   │    └─ claude / openai / gemini / qwen ──► provider API with the user's key
   ├─ aro-agent   GitHub coding agent (SSE), tools over the GitHub REST API
   ├─ file-process    Storage → Cloudinary
   └─ export-artifact md / pdf / docx / zip
                     ▲
 training/ (GPU) ────┘ publishes new ARO versions to a private Hugging Face repo;
   reads opted-in feedback from Firestore with the Admin SDK
```

## Chat: `ai-router`

- **Input:** `provider`, `model`, `messages` (text, or text and base64 images), `apiKey` (BYOK providers only) and `thinkingEnabled`.
- **Output:** SSE frames, in this order:
  - `{"meta": {"servedBy", "model"}}`
  - then `{"thinking"}` and `{"delta"}` frames
  - an `{"error"}` frame if something fails
  - finally `[DONE]`
- **ARO:** the router adds ARO's system prompt and calls the server at `ARO_MODEL_BASE_URL`. If that server can't be reached before any output, it moves to the `ARO_FALLBACK_*` endpoint. It never switches models partway through an answer.
- **Who answered:** `servedBy` records which model actually answered, and the app saves it on the message. Only `servedBy == "aro"` answers can ever become training data.
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

## ARO's training loop

The full details are in [training/README.md](training/README.md).

1. **Opt in.** In Settings → *Help improve ARO* (`users/{uid}.trainingConsent`), the user agrees to share their ARO chats. They rate answers 👍/👎 and can write a better answer.
2. **prepare** builds the day's training set:
   - only opted-in users, and only answers ARO itself gave that were rated, plus corrections
   - personal data and secrets scrubbed
   - duplicates removed
   - older data mixed back in
3. **train:** a QLoRA fine-tune of Qwen3-4B. **evaluate:** compares the new version with the current one on a fixed test set.
4. **promote:** if the new version is better, it is published to the Hugging Face repo with a one-step rollback. The model server then serves it.
