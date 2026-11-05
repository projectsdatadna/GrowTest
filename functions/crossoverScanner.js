/**
 * Crossover Scanner - on every timeframe (15 min, 1 hour, 4 hour, Daily,
 * Weekly) runs all six crossover indicators over each scanner symbol when a
 * new bar has closed, and raises an in-app alert (type 'crossover') for every
 * crossover on a newly closed bar. Driven by one scheduled dispatcher
 * (crossoverScanDispatch in functions/index.js) that ticks every 15 minutes
 * and scans only what is due - there is no manual trigger in the UI.
 *
 * Rule-based only - no AI call, so no token cost.
 *
 * Bar-close rules live in crossoverTimeframes.js. Candles come from
 * refreshAndLoadCandles, which always re-fetches the recent tail so a closed
 * bar carries its final values (see growwHistoricalData.js for why the
 * regular freshness check is not enough).
 */

import { refreshAndLoadWindow } from './crossoverCandleWindow.js'
import { computeIndicatorSpec } from './technicalIndicators.js'
import {
  TIMEFRAMES,
  TIMEFRAME_ORDER,
  candleEnd,
  isCandleClosed,
  latestExpectedBarEnd,
  DEFAULT_MIN_AGREEMENT,
} from './crossoverTimeframes.js'
import {
  listActiveScannerSymbols,
  ensureSeeded,
  getScannerSettings,
  setIntervalState,
  saveRunStatus,
  createCrossoverNotification,
  createScannerWarningNotification,
} from './crossoverScannerFirestoreClient.js'

// Closed bars looked at per scan, beyond the very first scan of a symbol:
// every closed bar that ended after the symbol's lastBarEnd, but never more
// than this many. Catches a missed run exactly without replaying history.
const MAX_CATCHUP_BARS = 3

// Other-indicator "confluence" lookback, in closed bars of the same timeframe.
const CONFLUENCE_BARS = 3

// A bar Groww has not published yet is retried on later ticks; after this many
// attempts for the same expected bar the scanner stops retrying it (e.g. an
// NSE holiday, where no bar will ever appear). The bar is still picked up by
// the catch-up rule on the next scan if it does turn up later.
const MAX_ATTEMPTS = { intraday: 3, day: 8, week: 8 }

const SYMBOL_CONCURRENCY = 4

// Stop starting new work this long into a run (the function timeout is 900s);
// whatever is left stays due and is picked up on the next tick.
const RUN_BUDGET_MS = 780000

// Same default params the Historical Chart tab uses (historicalChartSlice.js).
export const CROSSOVER_SPECS = [
  { spec: 'MACDCROSS:12:26:9', label: 'MACD 12/26/9', lineNames: { macd: 'MACD', signal: 'Signal' } },
  { spec: 'TSICROSS:25:13:13', label: 'TSI 25/13/13', lineNames: { tsi: 'TSI', signal: 'Signal' } },
  { spec: 'STOCHRSICROSS:14:14:3:3', label: 'Stoch RSI 14/14/3/3', lineNames: { k: '%K', d: '%D' } },
  { spec: 'ADXCROSS:14', label: 'ADX 14 (+DI/-DI)', lineNames: { pdi: '+DI', mdi: '-DI' } },
  { spec: 'SMACROSS:50:200', label: 'SMA 50/200', lineNames: { fast: 'SMA 50', slow: 'SMA 200' } },
  { spec: 'EMACROSS:12:26', label: 'EMA 12/26', lineNames: { fast: 'EMA 12', slow: 'EMA 26' } },
]

const AUTH_STATUS_CODES = new Set([401, 403])

function istDateString(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(date)
}

function round(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) / 100 : value
}

// growwHistoricalData.js throws a generic message and keeps the real cause
// (HTTP status + Groww's body) in error.details - surface it so the scanner
// shows "HTTP 403: ..." rather than only "Failed to fetch".
function describeError(error) {
  const d = error.details
  if (!d) return error.message
  const body = d.groww_error
  let reason = body?.error?.message || body?.message || d.message || ''
  if (!reason && body) reason = JSON.stringify(body)
  const suffix = reason ? ': ' + reason : ''
  return error.message + ' (HTTP ' + d.status_code + suffix + ')'
}

// Ascending by timestamp, one candle per timestamp (Groww has been seen to
// return a duplicate row for the same weekly timestamp; last one wins).
function dedupeByTimestamp(candles) {
  const byTimestamp = new Map()
  for (const candle of candles) byTimestamp.set(candle.timestamp, candle)
  return [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp)
}

export function notificationId({ exchange, symbol, interval, spec, direction, timestamp }) {
  return `xo_${exchange}_${symbol}_${interval}_${spec.replaceAll(':', '-')}_${direction}_${timestamp}`
}

/**
 * Whether this symbol still needs a scan on this timeframe at `nowSeconds`.
 * Pure - used by the dispatcher and tested offline.
 */
export function isIntervalDue(interval, state, nowSeconds) {
  const expectedEnd = latestExpectedBarEnd(interval, nowSeconds)
  if (expectedEnd == null) return false
  if (state?.skippedEnd === expectedEnd) return false
  return state?.lastBarEnd == null || state.lastBarEnd < expectedEnd
}

/**
 * Scans one symbol on one timeframe. Does not persist scan state itself - it
 * returns `statePatch` for the caller to store - so it can be replayed offline
 * with injected `loadCandles` / `persistAlert`.
 *
 * Returns { status, found, statePatch } where status is one of:
 *   'idle'           nothing is expected yet (no bar close in the last 10 days)
 *   'not-published'  Groww's series has no closed bar as new as expected yet
 *   'scanned'        crossovers evaluated; `found` lists each with `created`
 */
export async function scanSymbolInterval({
  symbol,
  exchange,
  interval,
  groww_token,
  now = new Date(),
  state = {},
  minAgreement = DEFAULT_MIN_AGREEMENT[interval] ?? 1,
  loadCandles = refreshAndLoadWindow,
  persistAlert = createCrossoverNotification,
}) {
  const config = TIMEFRAMES[interval]
  const nowSeconds = Math.floor(now.getTime() / 1000)
  const nowIso = now.toISOString()

  const expectedEnd = latestExpectedBarEnd(interval, nowSeconds)
  if (expectedEnd == null) return { status: 'idle', found: [], statePatch: null }

  const { candles, didBackfill } = await loadCandles({
    exchange,
    symbol,
    interval,
    groww_token,
    lookbackDays: config.lookbackDays,
    tailDays: config.tailDays,
    maxBars: config.maxBars,
    backfilled: Boolean(state.backfilledAt),
    now,
  })
  const backfilledAt = didBackfill ? nowIso : state.backfilledAt || null

  // Only closed, real trading bars feed the indicators - a forming bar's
  // close is provisional, and bars after the close (Groww's stray 15:45
  // 15-minute bar) are not tradeable bars at all.
  const closed = dedupeByTimestamp(candles).filter((c) => isCandleClosed(interval, c.timestamp, nowSeconds))
  const latestEnd = closed.length > 0 ? candleEnd(interval, closed[closed.length - 1].timestamp) : null

  if (latestEnd == null || latestEnd < expectedEnd) {
    const sameBar = state.pendingEnd === expectedEnd
    const attempts = (sameBar ? state.attempts || 0 : 0) + 1
    const giveUp = attempts >= MAX_ATTEMPTS[config.kind]
    return {
      status: 'not-published',
      found: [],
      statePatch: {
        lastScanAt: nowIso,
        lastError: null,
        backfilledAt,
        pendingEnd: giveUp ? null : expectedEnd,
        attempts: giveUp ? 0 : attempts,
        ...(giveUp ? { skippedEnd: expectedEnd } : {}),
      },
    }
  }

  // Bars to alert on: a first scan only looks at the single latest bar (no
  // history replay for a newly added symbol); afterwards, every closed bar
  // newer than the last one processed, capped.
  const alertBars =
    state.lastBarEnd == null
      ? closed.slice(-1)
      : closed.filter((c) => candleEnd(interval, c.timestamp) > state.lastBarEnd).slice(-MAX_CATCHUP_BARS)
  const alertTimestamps = new Set(alertBars.map((c) => c.timestamp))
  const confluenceTimestamps = new Set(closed.slice(-CONFLUENCE_BARS).map((c) => c.timestamp))
  const closeByTimestamp = new Map(closed.map((c) => [c.timestamp, c.close]))

  const barIndexByTimestamp = new Map(closed.map((c, i) => [c.timestamp, i]))
  const signals = []
  const alertEvents = []
  const confluencePool = []
  for (const def of CROSSOVER_SPECS) {
    let events
    try {
      events = computeIndicatorSpec(def.spec, closed)
    } catch (error) {
      console.error(`crossoverScanner: ${def.label} failed for ${exchange}:${symbol} ${interval}:`, error.message)
      continue
    }
    // The Overview's data: each indicator's most recent crossover on this
    // timeframe, whether or not it ends up alerting.
    const lastEvent = events.at(-1)
    if (lastEvent) {
      const { type, price, ...values } = lastEvent.value
      const lines = {}
      for (const [key, name] of Object.entries(def.lineNames)) lines[name] = round(values[key])
      signals.push({
        label: def.label,
        direction: type,
        ts: lastEvent.timestamp,
        barsAgo: closed.length - 1 - (barIndexByTimestamp.get(lastEvent.timestamp) ?? closed.length - 1),
        close: round(price ?? closeByTimestamp.get(lastEvent.timestamp)),
        lines,
      })
    }
    for (const event of events) {
      if (confluenceTimestamps.has(event.timestamp)) {
        confluencePool.push({ label: def.label, direction: event.value.type })
      }
      if (alertTimestamps.has(event.timestamp)) alertEvents.push({ def, event })
    }
  }

  const found = []
  for (const { def, event } of alertEvents) {
    const { type: direction, price, ...lineValues } = event.value
    const lines = {}
    for (const [key, name] of Object.entries(def.lineNames)) lines[name] = round(lineValues[key])

    const confluence = confluencePool.filter((c) => c.direction === direction && c.label !== def.label).map((c) => c.label)
    const agreement = 1 + confluence.length
    const fields = {
      symbol,
      exchange,
      interval,
      timeframeLabel: config.label,
      indicator: def.spec,
      indicatorLabel: def.label,
      direction,
      candleTimestamp: event.timestamp,
      closePrice: round(price ?? closeByTimestamp.get(event.timestamp)),
      lines,
      confluence,
      agreement,
    }
    // Below the timeframe's minimum agreement the crossover is not alerted
    // (it still shows on the Overview via `signals`).
    if (agreement < minAgreement) {
      found.push({ ...fields, created: false, suppressed: true })
      continue
    }
    const created = await persistAlert(notificationId({ exchange, symbol, interval, spec: def.spec, direction, timestamp: event.timestamp }), fields)
    found.push({ ...fields, created })
  }

  return {
    status: 'scanned',
    found,
    statePatch: {
      lastBarEnd: latestEnd,
      lastScanAt: nowIso,
      lastError: null,
      backfilledAt,
      pendingEnd: null,
      attempts: 0,
      summary: { asOf: closed.at(-1).timestamp, lastClose: round(closed.at(-1).close), signals },
    },
  }
}

async function runWithConcurrency(tasks, limit, deadline, worker) {
  const results = new Array(tasks.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) {
      const index = next++
      if (Date.now() > deadline) {
        results[index] = { skipped: true }
        continue
      }
      results[index] = await worker(tasks[index])
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * One dispatcher tick: for every enabled timeframe, scan each symbol that is
 * due. Idempotent - already-alerted crossovers are never re-alerted, and a
 * symbol with no scan state is simply due (so a newly added symbol is picked
 * up automatically on the next tick). `force` ignores the due check (diagnostic
 * only - the alert rule still only covers bars newer than the last one scanned).
 */
export async function runDispatch({ groww_token, now = new Date(), force = false }) {
  await ensureSeeded()
  const [symbols, settings] = await Promise.all([listActiveScannerSymbols(), getScannerSettings()])
  const nowSeconds = Math.floor(now.getTime() / 1000)
  const startedAt = Date.now()

  const tasks = []
  for (const interval of TIMEFRAME_ORDER) {
    if (!settings.enabledIntervals.includes(interval)) continue
    for (const entry of symbols) {
      const state = entry.scanState?.[interval] || {}
      if (force || isIntervalDue(interval, state, nowSeconds)) tasks.push({ entry, interval, state })
    }
  }

  const results = await runWithConcurrency(tasks, SYMBOL_CONCURRENCY, startedAt + RUN_BUDGET_MS, async ({ entry, interval, state }) => {
    try {
      const result = await scanSymbolInterval({ symbol: entry.symbol, exchange: entry.exchange, interval, groww_token, now, state, minAgreement: settings.minAgreement?.[interval] ?? DEFAULT_MIN_AGREEMENT[interval] })
      if (result.statePatch) await setIntervalState(entry.id, interval, result.statePatch)
      return { interval, symbol: entry.symbol, ok: true, status: result.status, found: result.found }
    } catch (error) {
      const message = describeError(error)
      console.error(`crossoverScanner: ${interval} scan failed for ${entry.exchange}:${entry.symbol}:`, message)
      await setIntervalState(entry.id, interval, { lastScanAt: now.toISOString(), lastError: { message, at: now.toISOString() } }).catch(() => {})
      return { interval, symbol: entry.symbol, ok: false, error: message, authFailure: AUTH_STATUS_CODES.has(error.details?.status_code), found: [] }
    }
  })

  const ran = results.filter((r) => !r.skipped)
  const perInterval = {}
  for (const interval of TIMEFRAME_ORDER) {
    const mine = ran.filter((r) => r.interval === interval)
    if (mine.length === 0) continue
    perInterval[interval] = {
      lastRunAt: now.toISOString(),
      expectedBarEnd: latestExpectedBarEnd(interval, nowSeconds),
      scanned: mine.filter((r) => r.ok && r.status === 'scanned').length,
      notPublished: mine.filter((r) => r.ok && r.status === 'not-published').length,
      newAlerts: mine.flatMap((r) => r.found).filter((f) => f.created).length,
      suppressed: mine.flatMap((r) => r.found).filter((f) => f.suppressed).length,
      errors: mine.filter((r) => !r.ok).length,
    }
  }

  // Token health: every Groww call rejected as unauthorized = the pasted token
  // has expired (they die daily) - raise the once-a-day warning instead of
  // failing quietly. Any success proves the token works.
  const tokenRejected = ran.length > 0 && ran.every((r) => r.authFailure)
  const tokenWorks = ran.some((r) => r.ok)
  if (tokenRejected) {
    await recordScannerTokenFailure(new Error('Groww rejected the access token (expired or invalid)'), now).catch(() => {})
  }

  await saveRunStatus({
    lastTickAt: now.toISOString(),
    intervals: perInterval,
    ...(tokenRejected
      ? { token: { ok: false, message: 'Groww rejected the access token (expired or invalid)', at: now.toISOString() } }
      : tokenWorks
        ? { token: { ok: true, message: null, at: now.toISOString() } }
        : {}),
  }).catch((error) => console.error('crossoverScanner: failed to save run status:', error.message))

  const newAlerts = ran.flatMap((r) => r.found).filter((f) => f.created)
  return {
    symbols: symbols.length,
    due: tasks.length,
    deferred: results.filter((r) => r.skipped).length,
    errors: ran.filter((r) => !r.ok).map((r) => ({ symbol: r.symbol, interval: r.interval, error: r.error })),
    newAlerts: newAlerts.length,
    alerts: newAlerts.map((f) => ({ symbol: f.symbol, interval: f.interval, indicator: f.indicatorLabel, direction: f.direction, candleTimestamp: f.candleTimestamp })),
  }
}

/**
 * Called when the Groww token can't be obtained - raises ONE warning per IST
 * day (idempotent id) so a missing/expired token isn't a silent no-op.
 */
export async function recordScannerTokenFailure(error, now = new Date()) {
  await saveRunStatus({ lastTickAt: now.toISOString(), token: { ok: false, message: error.message, at: now.toISOString() } }).catch(() => {})
  return createScannerWarningNotification(`scanner_warning_token_${istDateString(now)}`, {
    message: `Crossover scanner could not run: no valid Groww access token (${error.message}). Paste a fresh token in the Greek Analysis tab.`,
  })
}
