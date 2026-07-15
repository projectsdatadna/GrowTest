# Deploying the API to Firebase Cloud Functions

The Express API (`server.js`) has been adapted into a Firebase Cloud Function
at `functions/index.js`, targeting the **`devgraders`** project
(`.firebaserc`). This only covers the **API** — the frontend (`dist/`) is not
part of this setup, since `devgraders` is a shared project used by other
apps and its Hosting config wasn't touched.

## What's different from `server.js`

- No `app.listen()` — Cloud Functions invoke the exported handler directly.
- No static file serving / SPA catch-all — that's Hosting's job, not this
  Function's.
- Secrets (`GROWW_API_KEY`, `GROWW_API_SECRET`, `AZURE_OPENAI_API_KEY`,
  `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT`, `AZURE_OPENAI_API_VERSION`)
  come from Firebase Secret Manager via `defineSecret(...).value()`, not `.env`.
- `instruments-sample.json` is copied into `functions/` so it's included in
  the deployed bundle (local `readFileSync('./instruments-sample.json')`
  resolves relative to the function's own directory).

All route logic/behavior is otherwise identical to `server.js`.

## One-time setup

1. **Set the three secrets** (this also enables the Secret Manager API on
   first use — you'll be prompted to enable it if it isn't already):
   ```bash
   firebase functions:secrets:set GROWW_API_KEY --project devgraders
   firebase functions:secrets:set GROWW_API_SECRET --project devgraders
   firebase functions:secrets:set AZURE_OPENAI_API_KEY --project devgraders
   firebase functions:secrets:set AZURE_OPENAI_ENDPOINT --project devgraders
   firebase functions:secrets:set AZURE_OPENAI_DEPLOYMENT --project devgraders
   firebase functions:secrets:set AZURE_OPENAI_API_VERSION --project devgraders
   ```
   Each prompts for the value interactively — paste it and press enter.
   (`AZURE_OPENAI_API_VERSION` falls back to `2024-10-21` in code if you skip
   it, but Secret Manager has no notion of "unset optional" once the function
   declares it — set it explicitly to whatever `.env`'s `AZURE_OPENAI_API_VERSION`
   is, e.g. `2024-08-01-preview`.)

2. Confirm the **Blaze (pay-as-you-go) plan** is enabled on `devgraders` —
   required because this function makes outbound calls to Groww/Azure OpenAI.
   Spark (free) plan blocks all outbound network requests.

## Deploy

```bash
firebase deploy --only functions:api --project devgraders
```

**Important:** use `--only functions:api` (not the bare `--only functions`).
`devgraders` is a shared "CommonBackendProduct" project — a bare
`firebase deploy --only functions` diffs *all* functions in the project
against your local `functions/` folder and will prompt to **delete** any
functions it doesn't recognize, which could take down other apps' functions
in this same project. Scoping to `:api` deploys/updates only this one.

## Local testing (emulator, no deploy)

```bash
firebase emulators:exec --only functions "curl http://localhost:5002/devgraders/us-central1/api/health"
```

(Port 5002 is set in `firebase.json`'s `emulators.functions.port` since the
Functions emulator's own default, 5001, tends to collide with other local
dev servers.) The emulator
will warn that it can't reach Secret Manager unless you've run the secrets
setup above or provide overrides in `functions/.secret.local` (gitignored) —
that's expected for routes that don't touch Groww/Azure, like `/health`.

## Continuous deployment (GitHub Actions)

Pushes to `main` that touch `functions/**` auto-deploy via
`.github/workflows/deploy-functions.yml`, which runs the same scoped
`firebase deploy --only functions:api --project devgraders --non-interactive`
command as above. This still requires the **one-time secrets setup** above
(GitHub Actions deploys the function code; it does not set Secret Manager
values) plus a **one-time CI auth setup**:

1. Create a service account with deploy rights on `devgraders`, scoped to
   the specific roles a 2nd-gen Firebase Functions deploy needs (verified by
   an actual deploy — narrower than blanket `roles/editor`, since
   `devgraders` is shared with other apps):
   ```bash
   gcloud iam service-accounts create github-deploy-devgraders \
     --project devgraders --display-name "GitHub Actions deploy"

   SA="github-deploy-devgraders@devgraders.iam.gserviceaccount.com"
   for ROLE in roles/cloudfunctions.admin roles/run.admin \
     roles/iam.serviceAccountUser roles/cloudbuild.builds.editor \
     roles/artifactregistry.admin roles/storage.admin \
     roles/secretmanager.admin roles/serviceusage.serviceUsageAdmin; do
     gcloud projects add-iam-policy-binding devgraders \
       --member="serviceAccount:$SA" --role="$ROLE" --condition=None
   done

   gcloud iam service-accounts keys create key.json --iam-account="$SA"
   ```
   (`secretmanager.admin` is needed because `firebase deploy` grants the
   function's runtime service account access to each declared secret as
   part of deploying; `serviceusage.serviceUsageAdmin` is needed because
   deploy auto-enables any required API — e.g. `eventarc.googleapis.com`,
   `run.googleapis.com` — that isn't already on, and without this role that
   step fails with a permissions error instead.)
2. Add the contents of `key.json` as a GitHub Actions secret named
   `FIREBASE_SERVICE_ACCOUNT_DEVGRADERS` on this repo (Settings → Secrets and
   variables → Actions → New repository secret, or `gh secret set
   FIREBASE_SERVICE_ACCOUNT_DEVGRADERS < key.json`), then delete the local
   `key.json` — it's a live credential.
3. Push to `main`. The workflow picks up the secret automatically; no further
   config needed. Until step 2 is done, the workflow will run and fail at the
   auth step — commits still push fine, they just won't auto-deploy yet.

Manual `firebase deploy` (the section above) still works any time and is
useful for one-off deploys without waiting on CI.

**Gotcha hit on the first real deploy:** an old 1st-gen `api` function was
already sitting on `devgraders` from before `functions/index.js` was
rewritten to 2nd-gen (`firebase-functions/v2/https`) syntax. Firebase refuses
to deploy a 2nd-gen function over a 1st-gen one of the same name
(`Upgrading from 1st Gen to 2nd Gen is not yet supported`) — it has to be
deleted first: `gcloud functions delete api --project devgraders --region
us-central1`. This should only ever be needed once; noting it here in case
the function ever needs to be recreated from scratch.

## Frontend

Once deployed, point `VITE_API_BASE_URL` at the deployed function's URL
(printed after `firebase deploy`, or visible in the GitHub Actions log for
CI deploys — of the form
`https://us-central1-devgraders.cloudfunctions.net/api`) instead of
`http://localhost:5055`.
