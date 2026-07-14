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
- Secrets (`GROWW_API_KEY`, `GROWW_API_SECRET`, `CLAUDE_API_KEY`) come from
  Firebase Secret Manager via `defineSecret(...).value()`, not `.env`.
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
   firebase functions:secrets:set CLAUDE_API_KEY --project devgraders
   ```
   Each prompts for the value interactively — paste it and press enter.

2. Confirm the **Blaze (pay-as-you-go) plan** is enabled on `devgraders` —
   required because this function makes outbound calls to Groww/Anthropic.
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

(Port 5002 is set in `firebase.json`'s `emulators.functions.port` — the
default 5001 collides with this repo's own local dev server.) The emulator
will warn that it can't reach Secret Manager unless you've run the secrets
setup above or provide overrides in `functions/.secret.local` (gitignored) —
that's expected for routes that don't touch Groww/Claude, like `/health`.

## Frontend

Once deployed, point `VITE_API_BASE_URL` at the deployed function's URL
(printed after `firebase deploy`, of the form
`https://us-central1-devgraders.cloudfunctions.net/api`) instead of
`http://localhost:5001`.
