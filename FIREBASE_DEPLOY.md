# Deploying to Firebase (API + Frontend)

The Express API (`server.js`) has been adapted into a Firebase Cloud Function
at `functions/index.js`, and the React frontend (`dist/`, built by Vite) is
served via Firebase Hosting — both on the **`dev-cogniglob`** project
(`.firebaserc`; Firebase/GCP project display name may read "groww-dashboard"
if that manual rename in the console has been done — the project ID itself,
`dev-cogniglob`, is immutable and is what every command below uses). Both are
scoped defensively since `dev-cogniglob` is a shared project used by other
apps: the Function deploy always targets `--only functions:growtestApi`,
Hosting deploys to a **dedicated site** (`groww-dashboard`, target
`groww-dashboard-ui`), and Firestore uses a **dedicated named database**
(`groww-dashboard`) — never the project's shared defaults. See "Why a
dedicated database" and "Never name this function `api`" below for why this
matters here specifically, not just as generic caution.

## History: migrated off `devgraders`

This app originally deployed to a different shared project, `devgraders`
("CommonBackendProduct"). That project turned out to already have its own
unrelated function named `api` (a different, unrelated application's
production backend, complete with its own AWS/Azure/Composio secrets). A
routine deploy from this repo — using `--only functions:api`, believing that
name was ours — updated that colliding function with this app's code
instead of the other app's. The `api` name is apparently shared/managed
outside per-project "codebase" tracking, so `--only functions:<name>` will
happily overwrite *any* function of that name in the target project, not
just one this codebase created. No config in firebase.json/.firebaserc
prevents this — the only real protection is picking a function name unique
enough to never collide, and checking first.

This app has since moved entirely to `dev-cogniglob`, chosen specifically
because — after checking — it already has its own footprint (own `api`
function, own default Hosting site, own default Firestore database), the
same shape of risk as `devgraders` had. The mitigations below (dedicated
function name, dedicated Hosting site, dedicated Firestore database) exist
*because* of that incident, not as generic best practice.

`devgraders` itself was left running, not decommissioned — see git history
around 2026-08-04 if migrating further/cleaning that project up later.

## Why a dedicated Firestore database

`dev-cogniglob`'s default Firestore database (`(default)`) is in **Datastore
mode**, inherited from whatever app originally provisioned this project —
incompatible with the Native-mode query patterns this app uses (composite
indexes, `.where()/.orderBy()` chains in `functions/firestoreClient.js` and
`functions/watchlistFirestoreClient.js`). Rather than touch that shared
default database, this app created its own additional Native-mode database:

```bash
firebase firestore:databases:create groww-dashboard --location us-central1 --project dev-cogniglob
```

Both Firestore client files explicitly target it via
`getFirestore(admin.app(), 'groww-dashboard')` (the modular
`firebase-admin/firestore` API, not the namespaced `admin.firestore()`, which
always means "(default)"). `firebase.json`'s `firestore.database` field is
also pinned to `groww-dashboard`, so `firebase deploy --only firestore`
(rules/indexes) can never touch the shared default database either.

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

1. **Set the six secrets** (this also enables the Secret Manager API on
   first use — you'll be prompted to enable it if it isn't already):
   ```bash
   firebase functions:secrets:set GROWW_API_KEY --project dev-cogniglob
   firebase functions:secrets:set GROWW_API_SECRET --project dev-cogniglob
   firebase functions:secrets:set AZURE_OPENAI_API_KEY --project dev-cogniglob
   firebase functions:secrets:set AZURE_OPENAI_ENDPOINT --project dev-cogniglob
   firebase functions:secrets:set AZURE_OPENAI_DEPLOYMENT --project dev-cogniglob
   firebase functions:secrets:set AZURE_OPENAI_API_VERSION --project dev-cogniglob
   ```
   Each prompts for the value interactively — paste it and press enter. To
   set one non-interactively from a local `.env` without ever printing the
   value to your terminal history:
   ```bash
   grep '^GROWW_API_KEY=' .env | cut -d= -f2- | firebase functions:secrets:set GROWW_API_KEY --project dev-cogniglob --data-file - --force
   ```
   (`AZURE_OPENAI_API_VERSION` falls back to `2024-10-21` in code if you skip
   it, but Secret Manager has no notion of "unset optional" once the function
   declares it — set it explicitly to whatever `.env`'s `AZURE_OPENAI_API_VERSION`
   is, e.g. `2024-08-01-preview`.)

2. **Create the dedicated Firestore database** (one-time; already done as of
   this migration — see "Why a dedicated Firestore database" above):
   ```bash
   firebase firestore:databases:create groww-dashboard --location us-central1 --project dev-cogniglob
   firebase deploy --only firestore --project dev-cogniglob
   ```

3. Confirm the **Blaze (pay-as-you-go) plan** is enabled on `dev-cogniglob` —
   required because this function makes outbound calls to Groww/Azure OpenAI.
   Spark (free) plan blocks all outbound network requests.

## Deploy

```bash
firebase deploy --only functions:growtestApi --project dev-cogniglob
```

**Important:** use `--only functions:growtestApi` (not the bare
`--only functions`, and never `functions:api`). `dev-cogniglob` is a shared
project — a bare `firebase deploy --only functions` diffs *all* functions in
the project against your local `functions/` folder and will prompt to
**delete** any functions it doesn't recognize (including the project's own
unrelated `api` function), and deploying to the literal name `api` would
overwrite that unrelated function outright — see "History" above for exactly
that happening on the previous project. Scoping to `:growtestApi` deploys/
updates only this one.

After deploying, read the function's URL out of the deploy output and make
sure `.env.production` matches it exactly before building the frontend —
don't assume the URL pattern; 2nd-gen functions also expose a `*.run.app`
URL, and the backing Cloud Run service name is lowercased
(`growtestapi-*.run.app`), so copy what the CLI prints.

## Never name this function `api`

The HTTP function is exported as **`growtestApi`** in `functions/index.js`.
Do not rename it back to `api`, and before ever deploying to a *new* project
in the future, check what's already there first:

```bash
firebase functions:list --project <candidate-project>
firebase hosting:sites:list --project <candidate-project>
firebase firestore:databases:list --project <candidate-project>
```

How to recognize a name collision if one ever happens again — curl the base
URL and read the *body*, not just the status:

| Response | Meaning |
|---|---|
| `{"status":"ok","message":"Groww API Server is running"}` from `/health` | correct — our code is deployed |
| `{"error":"Endpoint not found"}` on a bogus path | our code is deployed; that path genuinely doesn't exist |
| `Cannot GET /health` (Express's default HTML 404) | **a different Express app is answering** — name collision, but the Cloud Run service still exists |
| Google's generic `<title>404 Page not found</title>` platform page | no function/route exists at all here (deleted, wrong name, or never deployed) |

## Local testing (emulator, no deploy)

```bash
firebase emulators:exec --only functions "curl http://localhost:5002/dev-cogniglob/us-central1/growtestApi/health"
```

(Port 5002 is set in `firebase.json`'s `emulators.functions.port` since the
Functions emulator's own default, 5001, tends to collide with other local
dev servers.) The emulator will warn that it can't reach Secret Manager
unless you've run the secrets setup above or provide overrides in
`functions/.secret.local` (gitignored) — that's expected for routes that
don't touch Groww/Azure, like `/health`.

## Continuous deployment (GitHub Actions)

Pushes to `main` that touch `functions/**` auto-deploy via
`.github/workflows/deploy-functions.yml`, which runs the same scoped
`firebase deploy --only functions:growtestApi,functions:watchlistTick,functions:watchlistCleanup --project dev-cogniglob --non-interactive`
command as above. This still requires the **one-time secrets setup** above
(GitHub Actions deploys the function code; it does not set Secret Manager
values) plus a **one-time CI auth setup**:

1. Create a service account with deploy rights on `dev-cogniglob`, scoped to
   the specific roles a 2nd-gen Firebase Functions deploy needs (narrower
   than blanket `roles/editor`, since `dev-cogniglob` is shared with other
   apps):
   ```bash
   gcloud iam service-accounts create github-deploy-dev-cogniglob \
     --project dev-cogniglob --display-name "GitHub Actions deploy"

   SA="github-deploy-dev-cogniglob@dev-cogniglob.iam.gserviceaccount.com"
   for ROLE in roles/cloudfunctions.admin roles/run.admin \
     roles/iam.serviceAccountUser roles/cloudbuild.builds.editor \
     roles/artifactregistry.admin roles/storage.admin \
     roles/secretmanager.admin roles/serviceusage.serviceUsageAdmin \
     roles/firebasehosting.admin roles/cloudscheduler.admin \
     roles/datastore.owner; do
     gcloud projects add-iam-policy-binding dev-cogniglob \
       --member="serviceAccount:$SA" --role="$ROLE" --condition=None
   done

   gcloud iam service-accounts keys create key.json --iam-account="$SA"
   ```
   (`secretmanager.admin` is needed because `firebase deploy` grants the
   function's runtime service account access to each declared secret as
   part of deploying; `serviceusage.serviceUsageAdmin` is needed because
   deploy auto-enables any required API — e.g. `eventarc.googleapis.com`,
   `run.googleapis.com` — that isn't already on, and without this role that
   step fails with a permissions error instead; `firebasehosting.admin` is
   for the separate frontend Hosting deploy, see "Frontend" below;
   `cloudscheduler.admin` is needed the moment any function uses
   `onSchedule` — e.g. `watchlistTick`/`watchlistCleanup` — since `firebase
   deploy` provisions/updates that function's backing Cloud Scheduler job
   directly, without it the scheduler-job step fails with `403: lacks IAM
   permission cloudscheduler.jobs.update`; `datastore.owner` covers the
   dedicated `groww-dashboard` Firestore database, since Firestore's IAM
   surface is still under the `datastore.*` permission namespace regardless
   of Native vs Datastore mode.)
2. Add the contents of `key.json` as a GitHub Actions secret named
   `FIREBASE_SERVICE_ACCOUNT_DEV_COGNIGLOB` on this repo (Settings → Secrets
   and variables → Actions → New repository secret, or `gh secret set
   FIREBASE_SERVICE_ACCOUNT_DEV_COGNIGLOB < key.json`), then delete the local
   `key.json` — it's a live credential.
3. Push to `main`. The workflow picks up the secret automatically; no further
   config needed. Until step 2 is done, the workflow will run and fail at the
   auth step — commits still push fine, they just won't auto-deploy yet.

   **This step could not be completed as part of the migration** — it
   requires `gcloud` (IAM service-account management isn't exposed via
   `firebase-tools`), and the `gcloud` session available at migration time
   had an expired/non-refreshable auth token requiring an interactive
   browser login. Run the commands above yourself once `gcloud auth login`
   works in your environment. Until then, deploy manually with the commands
   in "Deploy" / "Deploy (manual)" below — `firebase-tools` login is
   independent of `gcloud` and was working throughout the migration.

Manual `firebase deploy` (the section above) still works any time and is
useful for one-off deploys without waiting on CI.

## Frontend

The frontend deploys to a **dedicated Hosting site** (`groww-dashboard`,
`https://groww-dashboard.web.app`) rather than `dev-cogniglob`'s shared
default Hosting site (which already serves an unrelated Cogniglob site). The
site and target were created once via:

```bash
firebase hosting:sites:create groww-dashboard --project dev-cogniglob
firebase target:apply hosting groww-dashboard-ui groww-dashboard --project dev-cogniglob
```

`.firebaserc`'s `targets` block and `firebase.json`'s `hosting.target` both
already point at `groww-dashboard-ui` — this only needs to be redone if the
site is ever recreated from scratch.

`.env.production` pins the build's `VITE_API_BASE_URL` to the deployed Cloud
Function (`https://us-central1-dev-cogniglob.cloudfunctions.net/growtestApi`)
— `vite build` picks this up automatically in production mode, baking the
API URL into the static bundle (no runtime config needed). If the Function
URL ever changes (e.g. a different region), update this file and redeploy.

Because the URL is baked in at build time, a stale or wrong value here is
invisible until the UI 404s in production. After changing it, verify the
built bundle actually contains the new URL and no reference to the old
project:

```bash
npm run build
grep -o 'cloudfunctions.net/[a-zA-Z]*\|devgraders\|dev-cogniglob' dist/assets/index-*.js | sort -u
npm run smoke -- https://us-central1-dev-cogniglob.cloudfunctions.net/growtestApi
```

### Deploy (manual)

```bash
npm run build
firebase deploy --only hosting:groww-dashboard-ui --project dev-cogniglob
```

### Continuous deployment (GitHub Actions)

Pushes to `main` touching frontend files (`src/**`, `index.html`,
`package.json`, etc.) auto-deploy via `.github/workflows/deploy-ui.yml`,
which builds and runs the same scoped `firebase deploy --only
hosting:groww-dashboard-ui` command above. It reuses the same
`FIREBASE_SERVICE_ACCOUNT_DEV_COGNIGLOB` GitHub secret and service account as
the Functions workflow (see above) — that service account also needs
`roles/firebasehosting.admin`, which is included in the setup already
documented there.

## Renaming the project display name

GCP/Firebase project **IDs are immutable** — `dev-cogniglob` cannot become
`groww-dashboard` as an ID; every URL, CLI command, and config file in this
repo uses the ID and will keep saying `dev-cogniglob` regardless. Only the
**display name** shown in the Firebase/GCP consoles can be changed, via
Firebase Console → Project Settings → General → Project name (or GCP Console
→ IAM & Admin → Settings). This wasn't done as part of the migration — no
CLI command for it exists in `firebase-tools`, and the `gcloud` session
available at the time had an expired auth token requiring an interactive
browser login this environment couldn't perform.
