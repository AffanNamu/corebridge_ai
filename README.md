# ARO AI

An AI workspace built around **ARO**, one AI model family developed by **ARO Group**, plus a **GitHub coding agent** that works directly in your repositories.

ARO is released in generations. **ARO 1.5** is the current one; ARO 2.0 and later are planned. Within a generation, coding, research and translation are **capabilities** of the same assistant:

| ARO 1.5 capability | For |
|---|---|
| General | Conversation, writing, knowledge, reasoning |
| Code | Software engineering; powers the Code tab agent |
| Research | Maths, science, advanced reasoning |
| Translate | Multilingual, with a focus on African languages |
| Web search | Answers from live web results, with sources |

Vision, Voice and Creative are planned capabilities, not yet in any generation.

- **Chat** with *ARO 1.5 (Auto)*, which picks the right capability for each request, or choose one. Users can still bring their own Claude, ChatGPT, Gemini or Qwen key.
- **Code:** connect GitHub, pick a repository and describe a task. ARO reads the code, makes the change, pushes it and opens a pull request.
- **Plans:** Free, Pro and Premium plans, individual capability purchases and credits. They are enforced on the server and configured in the admin dashboard.
- **ARO keeps improving.** Users who opt in help train it with 👍/👎 and corrections. A new version goes live only if it beats the current one.

See [docs/MODELS.md](docs/MODELS.md) for the generations, capabilities, base models and licenses.

| Folder | What's inside |
|---|---|
| `apps/mobile` | Flutter app (Android): chat, Code tab, Models & Plan, admin dashboard, artifacts, files, settings |
| `apps/web` | Next.js web app (early) |
| `models` | The ARO family catalogue (generations and capabilities) and default plans (source of truth) |
| `supabase/functions` | Edge Functions: `ai-router` (chat and model router), `aro-agent` (GitHub agent), `aro-admin` (dashboard API), `file-process`, `export-artifact` |
| `supabase/migrations` | Postgres: model catalogue, plans, entitlements, usage, credits, admin functions |
| `firestore` | Security rules, indexes and their emulator tests |
| `training` | ARO Data Engine (dataset registry and license gate) and the training pipeline for the text models ([training/README.md](training/README.md)) |
| `docs` | [Architecture](docs/ARCHITECTURE.md) and [models](docs/MODELS.md) |

## Set up

You need the Firebase project (Auth + Firestore), the Supabase project (Edge Functions + Storage), and the [Supabase CLI](https://supabase.com/docs/guides/cli) and [Firebase CLI](https://firebase.google.com/docs/cli).

### 1. Deploy the Firestore rules and indexes

```bash
firebase deploy --only firestore:rules,firestore:indexes
```

These rules make every document private to its owner. Before this change the rules file was empty.

### 2. Create the plans database, set the secrets and deploy the functions

```bash
supabase link --project-ref <your-project-ref>
supabase db push                                            # catalogue, plans, entitlements, admin functions

cp supabase/functions/.env.example supabase/functions/.env   # fill it in; never commit it
supabase secrets set --env-file supabase/functions/.env
supabase functions deploy ai-router aro-agent aro-admin file-process export-artifact
```

**Make yourself an admin:**
1. Find your Firebase UID in the Firebase console → Authentication.
2. Put it in the `ADMIN_UIDS` secret.
3. Open the app → *Models & Plan* → *Admin*.

From the admin dashboard you set real prices, change daily limits, switch models live, and grant plans or credits.

**ARO models need a model server:**
- They answer once `ARO_MODEL_BASE_URL` points to a running ARO server. One server serves ARO 1.5, Code, Research and Translate; in production it's a RunPod Serverless endpoint that scales to zero.
- Cost controls (rate limits, agent caps, caching, GPU budget with alerts, per-request cost traces): [docs/COSTS.md](docs/COSTS.md).
- To start one on free Colab, see [training/README.md](training/README.md).
- Until then, the app says ARO is offline, or uses the backup model if you set `ARO_FALLBACK_*`.
- Every ARO request is checked against the user's plan, so the database migrations from the first command are required.

### 3. Build the app

```bash
cd apps/mobile
flutter pub get
flutter run \
  --dart-define=SUPABASE_URL=https://<project>.supabase.co \
  --dart-define=SUPABASE_ANON_KEY=<anon key> \
  --dart-define=SUPABASE_FUNCTIONS_URL=https://<project>.supabase.co/functions/v1 \
  --dart-define=CLOUDINARY_CLOUD_NAME=<cloud name>
```

Release builds run in GitHub Actions (`.github/workflows/release-android.yml`). They use these repository secrets:
- `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`
- `GOOGLE_SERVICES_JSON_BASE64`
- the `SUPABASE_*` and `CLOUDINARY_CLOUD_NAME` values above

> **Signing key:** the old release keystore was committed to this public repository and has been removed. It is still in the git history, so create a new keystore (`keytool -genkeypair -v -keystore aro-release.jks -alias aro -keyalg RSA -keysize 2048 -validity 10000`) and update the four `ANDROID_*` secrets. Never commit `*.jks` or `key.properties`.

## Tests

```bash
cd supabase/functions && deno test -A tests/                # router, GitHub agent, admin API, SQL (in-process Postgres)
cd apps/mobile && flutter analyze && flutter test          # app
cd firestore && npm install && npm test                    # security rules (emulator, needs Java)
cd training && pip install pytest httpx && pytest -q       # data engine, training pipeline, catalogue/seed sync
```

CI runs each of these when its folder changes.
