#!/usr/bin/env node
/**
 * API smoke test - hits every route and reports which ones are actually
 * reachable. Dependency-free (uses Node's global fetch), so it runs against
 * anything: the local server, the Firebase emulator, or production.
 *
 *   npm run smoke                                  # http://localhost:5055
 *   npm run smoke -- <base-url>                    # any deployment
 *   npm run smoke -- <base-url> --write             # also exercise mutating/AI routes
 *   npm run smoke -- <base-url> --strict            # dependency failures also exit non-zero
 *
 * Why this exists: this app's Cloud Function name has collided with an
 * unrelated app's function of the same name on a shared GCP project before
 * (see FIREBASE_DEPLOY.md, "History"/"Never name this function `api`") -
 * every route 404'd while our own code silently never actually shipped. The
 * identity assertion below catches that class of failure in one command.
 */

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith('--')))
const positional = argv.filter((a) => !a.startsWith('--'))

const BASE_URL = (positional[0] || process.env.SMOKE_BASE_URL || 'http://localhost:5055').replace(/\/$/, '')
const WRITE = flags.has('--write')
const STRICT = flags.has('--strict')
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 30000)

// A snapshot/watchlist id that cannot exist, for probing the :id routes
// without needing real data.
const BOGUS_ID = 'smoke-test-nonexistent-id'

/**
 * Outcome kinds, in order of severity. Only `fail` means "the route isn't
 * there" - the whole point is to keep routing problems distinguishable from
 * a Groww token that isn't saved or Firestore creds that aren't configured.
 */
const OK = 'ok' // 2xx
const REACHED = 'reached' // handler ran and declined (400/401, or its own 404)
const DEP = 'dep' // handler ran, a dependency (Groww/Azure/Firestore) failed
const FAIL = 'fail' // route missing, wrong app answering, or unreachable

/**
 * Routes mirror server.js and functions/index.js, which are hand-maintained
 * near-duplicates. If this table drifts from either one, that's a real bug
 * worth surfacing - keep all three in sync.
 *
 *   write:     mutates Firestore or spends Azure OpenAI tokens; needs --write
 *   ownNotFound: this route legitimately 404s with its own message, so a 404
 *              here is a pass as long as the body isn't the catch-all's
 */
const ROUTES = [
  { method: 'GET', path: '/health', assert: (b) => b?.status === 'ok' || 'expected {"status":"ok"}' },

  { method: 'GET', path: '/underlying-symbols' },
  { method: 'GET', path: '/quote?symbol=NIFTY' },
  { method: 'GET', path: '/quote', note: 'missing symbol -> 400' },
  { method: 'GET', path: '/option-expiries?symbol=NIFTY' },
  { method: 'GET', path: '/option-chain?underlying_symbol=NIFTY' },
  { method: 'GET', path: '/historical?symbol=NIFTY&interval=1day&count=5' },

  { method: 'GET', path: '/option-chain-snapshots' },
  { method: 'GET', path: `/option-chain-snapshots/${BOGUS_ID}`, ownNotFound: 'Snapshot not found' },

  { method: 'GET', path: '/watchlist' },
  { method: 'GET', path: `/watchlist/${BOGUS_ID}/analysis/5m` },
  { method: 'GET', path: `/watchlist/${BOGUS_ID}/analysis/bogus`, note: 'bad tier -> 400' },

  // Mutating / AI-spending routes. Bodies are deliberately minimal: reaching
  // the handler at all is the assertion, a 400 back is a pass.
  {
    method: 'POST',
    path: '/groww-access-token',
    body: {},
    note: 'empty body -> 400',
  },
  { method: 'POST', path: '/analyze-option-chain', body: {}, write: true },
  { method: 'POST', path: '/analyze-option-chain-range', body: {}, write: true },
  { method: 'POST', path: '/ai/inference', body: {}, write: true },
  { method: 'POST', path: '/compare-option-chain-snapshots', body: {}, write: true },
  { method: 'POST', path: `/option-chain-snapshots/${BOGUS_ID}/regenerate-analysis`, body: {}, write: true },
  { method: 'POST', path: '/watchlist', body: {}, write: true },
  { method: 'DELETE', path: `/watchlist/${BOGUS_ID}`, write: true },
]

async function request(method, path, body) {
  const url = `${BASE_URL}${path}`
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      // Non-JSON body is itself a signal - Express's default 404 is HTML.
    }
    return { status: res.status, text, json }
  } catch (error) {
    return { status: 0, text: '', json: null, networkError: error.message }
  }
}

/**
 * Does the app answering on this URL look like OUR app?
 *
 * A bogus path must hit our own catch-all, which returns JSON
 * {"error":"Endpoint not found"} (server.js / functions/index.js). Express's
 * stock 404 is HTML reading `Cannot GET /...`, which means a *different*
 * Express app is behind this URL - and Google's own generic platform 404
 * page means no function/route exists here at all. Either is a hard FAIL.
 */
async function checkIdentity() {
  const probe = '/__smoke_identity_probe__'
  const res = await request('GET', probe)

  if (res.networkError) {
    return {
      ok: false,
      headline: `Cannot reach ${BASE_URL} - ${res.networkError}`,
      detail: 'Is the server running? Local: `npm run server` (port 5055).',
    }
  }
  if (res.json?.error === 'Endpoint not found') {
    return { ok: true }
  }
  if (/Cannot (GET|POST|DELETE)/i.test(res.text)) {
    return {
      ok: false,
      headline: `A DIFFERENT Express app is serving ${BASE_URL}`,
      detail:
        `A bogus path returned Express's default 404 ("Cannot GET ${probe}") instead of\n` +
        `  our catch-all's {"error":"Endpoint not found"}. Our code is not deployed here.\n` +
        `  Most likely the Cloud Function name collides with another app on a shared\n` +
        `  project - see FIREBASE_DEPLOY.md, "Never name this function \`api\`".`,
    }
  }
  if (/page not found/i.test(res.text)) {
    return {
      ok: false,
      headline: `No function/route exists at all at ${BASE_URL}`,
      detail: 'Google platform-level 404 - the function was deleted, renamed, or never deployed here.',
    }
  }
  return {
    ok: false,
    headline: `Unrecognized app serving ${BASE_URL}`,
    detail:
      `A bogus path returned HTTP ${res.status}: ${res.text.slice(0, 200).replace(/\s+/g, ' ')}\n` +
      `  Expected our catch-all's {"error":"Endpoint not found"}.`,
  }
}

function classify(route, res) {
  if (res.networkError) return { kind: FAIL, why: res.networkError }

  // The catch-all answering means this route does not exist in the deployed
  // build - the exact signature of the bug this script was written for.
  if (res.status === 404) {
    if (res.json?.error === 'Endpoint not found') {
      return { kind: FAIL, why: 'route missing (hit the 404 catch-all)' }
    }
    if (!res.json) {
      return { kind: FAIL, why: `not our app (${res.text.slice(0, 60).replace(/\s+/g, ' ')})` }
    }
    if (route.ownNotFound) {
      return { kind: OK, why: res.json.error }
    }
    return { kind: FAIL, why: `unexpected 404: ${res.json.error}` }
  }

  if (res.status >= 200 && res.status < 300) {
    if (route.assert) {
      const verdict = route.assert(res.json)
      if (verdict !== true) return { kind: FAIL, why: String(verdict) }
    }
    return { kind: OK, why: '' }
  }

  // Handler ran and declined. Not a routing problem: most routes need a Groww
  // access token saved via POST /groww-access-token first.
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    return { kind: REACHED, why: truncate(res.json?.error) || `HTTP ${res.status}` }
  }

  if (res.status >= 500) {
    return { kind: DEP, why: truncate(res.json?.error) || `HTTP ${res.status}` }
  }

  return { kind: REACHED, why: `HTTP ${res.status}` }
}

function truncate(s, n = 64) {
  if (!s) return ''
  const flat = String(s).replace(/\s+/g, ' ')
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat
}

const useColor = process.stdout.isTTY && !process.env.NO_COLOR
const paint = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s)
const BADGE = {
  [OK]: () => paint('32', 'ok    '),
  [REACHED]: () => paint('36', 'auth  '),
  [DEP]: () => paint('33', 'dep!  '),
  [FAIL]: () => paint('31;1', 'FAIL  '),
}

async function main() {
  console.log(`\nAPI smoke test -> ${paint('1', BASE_URL)}`)
  if (!WRITE) console.log(paint('90', 'read-only mode; pass --write to exercise mutating/AI routes'))
  console.log()

  const identity = await checkIdentity()
  if (!identity.ok) {
    console.log(`${paint('31;1', '✗ ' + identity.headline)}\n  ${identity.detail}\n`)
    console.log(paint('90', 'Skipping the route table - its results would be meaningless.\n'))
    process.exit(1)
  }
  console.log(`${paint('32', '✓')} identity: our 404 catch-all is answering, so this is our app\n`)

  const results = []
  for (const route of ROUTES) {
    const label = `${route.method.padEnd(6)} ${route.path}`

    if (route.write && !WRITE) {
      console.log(`${paint('90', 'skip  ')} ${label}  ${paint('90', '(mutates data / spends tokens)')}`)
      results.push({ route, kind: 'skip' })
      continue
    }

    const res = await request(route.method, route.path, route.body)
    const { kind, why } = classify(route, res)
    const note = why || route.note || ''
    console.log(`${BADGE[kind]()} ${label}  ${paint('90', note ? `${res.status} ${note}` : String(res.status))}`)
    results.push({ route, kind, why, status: res.status })
  }

  const count = (k) => results.filter((r) => r.kind === k).length
  const failures = results.filter((r) => r.kind === FAIL)
  const deps = results.filter((r) => r.kind === DEP)

  console.log(
    `\n${results.length} routes: ` +
      [
        `${count(OK)} ok`,
        `${count(REACHED)} auth-gated`,
        `${count(DEP)} dependency-failed`,
        `${count('skip')} skipped`,
        `${failures.length} FAILED`,
      ].join(', ')
  )

  if (deps.length) {
    console.log(
      `\n${paint('33', 'Dependency failures')} - the route exists and ran, but something it calls ` +
        `(Groww, Azure OpenAI, Firestore) errored. Not a routing problem:`
    )
    for (const d of deps) console.log(`  ${d.route.method} ${d.route.path} -> ${d.why}`)
  }

  if (failures.length) {
    console.log(`\n${paint('31;1', 'ROUTING FAILURES')} - these routes are not reachable:`)
    for (const f of failures) console.log(`  ${f.route.method} ${f.route.path} -> ${f.why}`)
    console.log(
      '\nIf every route failed, the deployed build is almost certainly not this code.\n' +
        'See FIREBASE_DEPLOY.md, "Never name this function `api`".'
    )
    process.exit(1)
  }

  if (deps.length && STRICT) {
    console.log(paint('33', '\n--strict: exiting non-zero because of the dependency failures above.'))
    process.exit(1)
  }

  console.log(paint('32', '\n✓ All reachable routes accounted for; no routing failures.\n'))
}

main().catch((error) => {
  console.error(`\nSmoke test crashed: ${error.stack || error.message}`)
  process.exit(1)
})
