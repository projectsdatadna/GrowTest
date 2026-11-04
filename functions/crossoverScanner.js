/**
 * Crossover Scanner - once per closed 1-hour candle during market hours,
 * runs all six crossover indicators over each scanner symbol and raises an
 * in-app alert (historicalWatchlistNotifications, type 'crossover') for every
 * crossover that landed on a newly closed candle.
 *
 * Rule-based only - no AI call, so no token cost.
 *
 * Candle timing (verified against postman/results/*\/1hour_60d.json): Groww's
 * 1-hour bars are clock-aligned - start 09:00, 10:00 ... 15:00 IST. The 09:00
 * bar covers 9:15-10:00 and the 15:00 bar only 15:00-15:30. A bar is CLOSED
 * once its end (start + 1h, capped at the 15:30 market close) has passed;
 * a crossover on a still-forming bar is never alerted, since it can vanish
 * before the bar finishes.
 */

import { ensureCandlesFresh } from './growwHistoricalData.js'
import { computeIndicatorSpec } from './technicalIndicators.js'
import {
  listActiveScannerSymbols,
  ensureSeeded,
  updateScanState,
  saveScanError,
  createCrossoverNotification,
  createScannerWarningNotification,
} from './crossoverScannerFirestoreClient.js'

const INTERVAL = '1hour'
const BAR_SECONDS = 3600

// SMA 50/200 needs 200 bars and there are ~7 hourly bars per trading day, so
// 90 calendar days (~430 bars) leaves a comfortable margin. Within the 179-day
// single-chunk limit for hourly data (growwHistoricalData.js MAX_SPAN_DAYS).
const LOOKBACK_DAYS = 90

// How many most-recent closed bars to look for crossovers on. 2 (not 1) so one
// missed/late run (e.g. Groww publishing a bar a few minutes late) is still
// caught by the next hour's run - the deterministic notification id makes the
// overlap harmless.
const RECENT_CLOSED_BARS = 2

// Other-indicator "confluence" lookback, in closed bars.
const CONFLUENCE_BARS = 3

const SYMBOL_CONCURRENCY = 4

const IST_OFFSET_SECONDS = 5.5 * 3600
const MARKET_CLOSE_SECONDS_IST = 15 * 3600 + 30 * 60

// Same default params the Historical Chart tab uses (historicalChartSlice.js).
export const CROSSOVER_SPECS = [
  { spec: 'MACDCROSS:12:26:9', label: 'MACD 12/26/9', lineNames: { macd: 'MACD', signal: 'Signal' } },
  { spec: 'TSICROSS:25:13:13', label: 'TSI 25/13/13', lineNames: { tsi: 'TSI', signal: 'Signal' } },
  { spec: 'STOCHRSICROSS:14:14:3:3', label: 'Stoch RSI 14/14/3/3', lineNames: { k: '%K', d: '%D' } },
  { spec: 'ADXCROSS:14', label: 'ADX 14 (+DI/-DI)', lineNames: { pdi: '+DI', mdi: '-DI' } },
  { spec: 'SMACROSS:50:200', label: 'SMA 50/200', lineNames: { fast: 'SMA 50', slow: 'SMA 200' } },
  { spec: 'EMACROSS:12:26', label: 'EMA 12/26', lineNames: { fast: 'EMA 12', slow: 'EMA 26' } },
]

/** Close time (epoch seconds) of the IST trading day a candle belongs to. */
function marketCloseForCandle(timestamp) {
  const istDayStart = Math.floor((timestamp + IST_OFFSET_SECONDS) / 86400) * 86400 - IST_OFFSET_SECONDS
  return istDayStart + MARKET_CLOSE_SECONDS_IST
}

export function candleEndTimestamp(startTimestamp) {
  return Math.min(startTimestamp + BAR_SECONDS, marketCloseForCandle(startTimestamp))
}

export function isCandleClosed(startTimestamp, nowSeconds) {
  return candleEndTimestamp(startTimestamp) <= nowSeconds
}

/**
 * Whether `now` is a time the scanner should run: a trading weekday between
 * the first bar close (10:00) and shortly after market close. Deliberately
 * NOT isWithinMarketHours - that one ends at 15:30, but the 15:00 bar closes
 * at exactly 15:30 and its scan runs at ~15:32.
 */
export function isScanWindow(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now)
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]))
  if (!['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(map.weekday)) return false
  const minutes = (parseInt(map.hour, 10) % 24) * 60 + parseInt(map.minute, 10)
  return minutes >= 10 * 60 && minutes <= 15 * 60 + 45
}

function istDateString(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(date)
}

function round(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) / 100 : value
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await mapper(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

const AUTH_STATUS_CODES = new Set([401, 403])

// growwHistoricalData.js throws a generic message and keeps the real cause
// (HTTP status + Groww's body) in error.details - surface it so the scanner
// table shows "HTTP 403: ..." rather than only "Failed to fetch".
function describeError(error) {
  const d = error.details
  if (!d) return error.message
  const body = d.groww_error
  let reason = body?.error?.message || body?.message || d.message || ''
  if (!reason && body) reason = JSON.stringify(body)
  const suffix = reason ? ': ' + reason : ''
  return error.message + ' (HTTP ' + d.status_code + suffix + ')'
}

function notificationId({ exchange, symbol, spec, direction, timestamp }) {
  return `xo_${exchange}_${symbol}_${spec.replaceAll(':', '-')}_${direction}_${timestamp}`
}

/**
 * Scans one symbol. Returns the list of crossovers found on the last
 * RECENT_CLOSED_BARS closed bars, with `created` marking which were newly
 * alerted (false = already alerted by an earlier run).
 */
export async function scanSymbol({ symbol, exchange, groww_token, now = new Date() }) {
  const nowSeconds = Math.floor(now.getTime() / 1000)
  const rangeStart = new Date(now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000)

  const { candles } = await ensureCandlesFresh({ exchange, symbol, interval: INTERVAL, rangeStart, rangeEnd: now, groww_token })

  // Only closed bars feed the indicators - a forming bar's close is provisional.
  const closed = candles.filter((c) => isCandleClosed(c.timestamp, nowSeconds))
  if (closed.length === 0) return { latestClosedTimestamp: null, found: [] }

  const latestClosedTimestamp = closed[closed.length - 1].timestamp
  const recentTimestamps = new Set(closed.slice(-RECENT_CLOSED_BARS).map((c) => c.timestamp))
  const confluenceTimestamps = new Set(closed.slice(-CONFLUENCE_BARS).map((c) => c.timestamp))
  const closeByTimestamp = new Map(closed.map((c) => [c.timestamp, c.close]))

  const recentEvents = []
  const confluencePool = []
  for (const def of CROSSOVER_SPECS) {
    let events
    try {
      events = computeIndicatorSpec(def.spec, closed)
    } catch (error) {
      console.error(`crossoverScanner: ${def.label} failed for ${exchange}:${symbol}:`, error.message)
      continue
    }
    for (const event of events) {
      if (confluenceTimestamps.has(event.timestamp)) {
        confluencePool.push({ label: def.label, direction: event.value.type, timestamp: event.timestamp })
      }
      if (recentTimestamps.has(event.timestamp)) recentEvents.push({ def, event })
    }
  }

  const found = []
  for (const { def, event } of recentEvents) {
    const { type: direction, price, ...lineValues } = event.value
    const lines = {}
    for (const [key, name] of Object.entries(def.lineNames)) lines[name] = round(lineValues[key])

    const confluence = confluencePool
      .filter((c) => c.direction === direction && c.label !== def.label)
      .map((c) => c.label)
    const fields = {
      symbol,
      exchange,
      interval: INTERVAL,
      indicator: def.spec,
      indicatorLabel: def.label,
      direction,
      candleTimestamp: event.timestamp,
      closePrice: round(price ?? closeByTimestamp.get(event.timestamp)),
      lines,
      confluence,
    }
    const created = await createCrossoverNotification(
      notificationId({ exchange, symbol, spec: def.spec, direction, timestamp: event.timestamp }),
      fields
    )
    found.push({ ...fields, created })
  }

  return { latestClosedTimestamp, found }
}

/**
 * Scans every active scanner symbol (seeding the default list on first use).
 * One symbol failing never stops the rest - its error is recorded on its own
 * doc. Returns a summary for logs / the manual "Scan now" button.
 */
export async function runScan({ groww_token, now = new Date() }) {
  await ensureSeeded()
  const symbols = await listActiveScannerSymbols()

  const results = await mapWithConcurrency(symbols, SYMBOL_CONCURRENCY, async (entry) => {
    try {
      const { latestClosedTimestamp, found } = await scanSymbol({ symbol: entry.symbol, exchange: entry.exchange, groww_token, now })
      await updateScanState(entry.id, { lastScannedCandleTs: latestClosedTimestamp })
      return { symbol: entry.symbol, ok: true, found }
    } catch (error) {
      const message = describeError(error)
      console.error(`crossoverScanner: scan failed for ${entry.exchange}:${entry.symbol}:`, message)
      await saveScanError(entry.id, message).catch(() => {})
      return { symbol: entry.symbol, ok: false, error: message, authFailure: AUTH_STATUS_CODES.has(error.details?.status_code), found: [] }
    }
  })

  // Every Groww call rejected as unauthorized = the pasted token has expired
  // (they die daily) - raise the once-a-day warning instead of failing quietly.
  if (results.length > 0 && results.every((r) => r.authFailure)) {
    await recordScannerTokenFailure(new Error('Groww rejected the access token (expired or invalid)'), now).catch(() => {})
  }

  const newAlerts = results.flatMap((r) => r.found).filter((f) => f.created)
  return {
    scanned: results.length,
    errors: results.filter((r) => !r.ok).map((r) => ({ symbol: r.symbol, error: r.error })),
    newAlerts: newAlerts.length,
    alerts: newAlerts.map((f) => ({ symbol: f.symbol, indicator: f.indicatorLabel, direction: f.direction, candleTimestamp: f.candleTimestamp })),
  }
}

/**
 * Called when the Groww token can't be obtained - raises ONE warning per IST
 * day (idempotent id) so a missing/expired token isn't a silent no-op.
 */
export async function recordScannerTokenFailure(error, now = new Date()) {
  return createScannerWarningNotification(`scanner_warning_token_${istDateString(now)}`, {
    message: `Crossover scanner could not run: no valid Groww access token (${error.message}). Paste a fresh token in the Greek Analysis tab.`,
  })
}
