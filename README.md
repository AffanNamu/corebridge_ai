# ARO AI

An AI workspace with its own model, **ARO 1.5**, and a **GitHub coding agent** that works directly in your repositories.

- **Chat** with ARO 1.5, which is built in and needs no key. You can also use your own Claude, ChatGPT, Gemini or Qwen key.
- **Code**: connect GitHub, pick a repository and describe a task. ARO reads the code, makes the change, pushes it and opens a pull request.
- **ARO keeps improving.** Users who opt in help train it with 👍/👎 and corrections. A new version goes live only if it beats the current one.

| Folder | What's inside |
|---|---|
| `apps/mobile` | Flutter app (Android): chat, Code tab, artifacts, files, settings |
| `apps/web` | Next.js web app (early) |
| `supabase/functions` | Edge Functions: `ai-router` (chat), `aro-agent` (GitHub agent), `file-process`, `export-artifact` |
| `firestore` | Security rules, indexes and their emulator tests |
| `training` | ARO training pipeline and the Colab notebook ([training/README.md](training/README.md)) |
| `docs` | [Architecture](docs/ARCHITECTURE.md) |

## Set up

You need the Firebase project (Auth + Firestore), the Supabase project (Edge Functions + Storage), and the [Supabase CLI](https://supabase.com/docs/guides/cli) and [Firebase CLI](https://firebase.google.com/docs/cli).

### 1. Deploy the Firestore rules and indexes

```bash
firebase deploy --only firestore:rules,firestore:indexes
```

These rules make every document private to its owner. Before this change the rules file was empty.

### 2. Set the server secrets and deploy the functions

```bash
cp supabase/functions/.env.example supabase/functions/.env   # fill it in; never commit it
supabase secrets set --env-file supabase/functions/.env
supabase functions deploy ai-router aro-agent file-process export-artifact
```

ARO 1.5 answers once `ARO_MODEL_BASE_URL` points to a running ARO server. To start one on free Colab, see [training/README.md](training/README.md). Until then, the app tells users ARO is unavailable, or uses the backup model if you set `ARO_FALLBACK_*`.

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
cd supabase/functions && deno test --allow-env tests/      # router + GitHub agent
cd apps/mobile && flutter analyze && flutter test          # app
cd firestore && npm install && npm test                    # security rules (emulator, needs Java)
cd training && pip install pytest httpx && pytest -q       # training pipeline
```

CI runs each of these when its folder changes.
