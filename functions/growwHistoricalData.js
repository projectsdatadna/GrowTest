/**
 * Groww historical OHLC candle fetch + on-demand freshness orchestration for
 * the Historical Chart feature. Parallel to growwOptionChain.js (same
 * error-throwing-with-.details convention), but Groww's historical/candles
 * endpoint has a genuinely different, non-obvious request contract from
 * every other Groww call in this app - verified live against the real API
 * on 2026-09-17 (the existing /historical route in server.js/functions/
 * index.js sends the WRONG params and has never actually worked: it's
 * missing `segment` and sends `symbol` where Groww wants `groww_symbol`).
 *
 * `ensureCandlesFresh` takes an explicit `rangeStart`/`rangeEnd` (JS Dates)
 * matching Groww's own start_time/end_time contract directly - the route
 * layer (server.js/functions/index.js) parses those out of the request, this
 * module never invents a "count" abstraction on top.
 */

import axios from 'axios'
import { isWithinMarketHours } from './watchlistScheduler.js'
import { listCandlesInRange, saveCandlesBatch } from './historicalDataFirestoreClient.js'

const GROWW_API_BASE_URL = 'https://api.groww.in/v1'
const GROWW_API_VERSION = '1.0'

// Every value here is confirmed against a live call (2026-09-17/18) - Groww's
// accepted set is a specific enum, not freeform minutes (e.g. '1440', bare
// 'day', and '60minute' were all rejected - the hour interval is '1hour').
// Cross-checked against the official docs
// (groww.in/trade-api/docs/curl/backtesting#get-historical-candle-data),
// which group these into the same three duration tiers reproduced in
// MAX_SPAN_DAYS below. Verify live before adding anything beyond this set.
export const SUPPORTED_INTERVALS = {
  '1minute': 1,
  '2minute': 2,
  '3minute': 3,
  '5minute': 5,
  '10minute': 10,
  '15minute': 15,
  '30minute': 30,
  '1hour': 60,
  '4hour': 240,
  '1day': 1440,
  '1week': 10080,
  '1month': 43200, // approximate (30 days) - only used as a rough calendarDaysBackForCount multiplier, not exact trading-day math
}

// Groww caps how many days a single historical/candles call can span - also
// verified live, and it's NOT the same for every interval: a request past
// this errors with "Interval X can only be queried for a maximum of Y days"
// (GA001) instead of just truncating. Matches the docs' three tiers exactly
// (30/90/180 days), each shaved by a day to leave slack against any
// off-by-one in how "days" gets counted on Groww's side.
const MAX_SPAN_DAYS = {
  '1minute': 29,
  '2minute': 29,
  '3minute': 29,
  '5minute': 29, // confirmed tier: 30 days
  '10minute': 89,
  '15minute': 89,
  '30minute': 89, // confirmed tier: 90 days
  '1hour': 179,
  '4hour': 179,
  '1day': 179,
  '1week': 179,
  '1month': 179, // confirmed tier: 180 days
}

// groww_symbol is a plain string join, confirmed against instruments-
// sample.csv/json (NIFTY -> NSE-NIFTY, TCS -> NSE-TCS, etc.) - no CSV
// lookup needed at request time.
function buildGrowwSymbol(exchange, symbol) {
  return `${exchange}-${symbol}`
}

// Groww's start_time/end_time params are IST local wall-clock strings
// ('YYYY-MM-DD HH:MM:SS'), not UTC/epoch - format explicitly in
// Asia/Kolkata regardless of the Cloud Function runtime's own timezone
// (UTC), the same way watchlistScheduler.js's getIstParts does for market-
// hours checks.
function formatGrowwDateTime(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date)
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]))
  return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second}`
}

// Parses a start_time/end_time query param as IST wall-clock time into a JS
// Date, the inverse of formatGrowwDateTime. Accepts both Groww's own
// 'YYYY-MM-DD HH:MM:SS' shape and the frontend datetime-local input's native
// 'YYYY-MM-DDTHH:mm' shape (no seconds). A bare `new Date(string)` on either
// is silently read as UTC when there's no offset in the string - same
// 5.5-hour-shift trap as parsing Groww's own candle timestamps - so this
// always appends '+05:30' explicitly rather than trusting the runtime's
// default parsing.
export function parseIstDateTime(input) {
  const normalized = input.trim().replace(' ', 'T')
  const withSeconds = normalized.length === 16 ? `${normalized}:00` : normalized
  const date = new Date(`${withSeconds}+05:30`)
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date/time: "${input}" - expected "YYYY-MM-DD HH:MM:SS" or "YYYY-MM-DDTHH:mm"`)
  }
  return date
}

// Turns one of Groww's 7-element candle rows into a clean candle object.
// row[0] is an ISO-ish string with NO timezone offset ("2026-09-16T09:15:00")
// that represents IST local time - passing it straight to Date.parse() is
// silently interpreted as UTC, shifting every candle by 5.5 hours. Append
// '+05:30' explicitly. row[6] is always null in every sample observed (cash
// equity + index) - ignored. Does NOT fix up a null open (see
// fillMissingOpens) - kept separate so it stays correct across chunked
// fetches (see MAX_SPAN_DAYS) where each chunk is parsed independently but
// opens need filling in against the FULL concatenated series, not per-chunk.
export function parseGrowwCandles(responseData) {
  const rows = responseData?.payload?.candles || []
  return rows.map(([isoTimestamp, open, high, low, close, volume]) => ({
    timestamp: Math.floor(Date.parse(`${isoTimestamp}+05:30`) / 1000),
    open,
    high,
    low,
    close,
    volume: volume ?? 0,
  }))
}

// row[1] (open) can be null on some historical daily rows even when
// high/low/close/volume are populated (observed on real TCS data). Fill it
// from the previous candle's close, the standard "prior close stands in for
// a missing open print" convention - needed because Plotly's ohlc trace
// requires a numeric open per point. `candles` must already be in
// chronological order across all fetched chunks combined - filling per-
// chunk would lose continuity at chunk boundaries.
function fillMissingOpens(candles) {
  let previousClose = null
  for (const candle of candles) {
    if (candle.open == null) {
      candle.open = previousClose ?? candle.close
    }
    previousClose = candle.close
  }
  return candles
}

// Splits [rangeStart, rangeEnd] into consecutive chunks no wider than this
// interval's MAX_SPAN_DAYS - Groww rejects a single call spanning more than
// that with a GA001 error rather than truncating it itself.
function buildDateChunks(rangeStart, rangeEnd, interval) {
  const maxSpanMs = MAX_SPAN_DAYS[interval] * 24 * 60 * 60 * 1000
  const chunks = []
  let chunkStart = rangeStart
  while (chunkStart < rangeEnd) {
    const chunkEnd = new Date(Math.min(chunkStart.getTime() + maxSpanMs, rangeEnd.getTime()))
    chunks.push([chunkStart, chunkEnd])
    chunkStart = chunkEnd
  }
  return chunks
}

/**
 * Ensures Firestore has fresh-enough candles for this symbol/exchange/
 * interval/[rangeStart, rangeEnd], fetching from Groww if needed, then
 * returns every candle in that range (ascending by timestamp). A fetch is
 * warranted when stored data doesn't reach back to the start of the
 * requested range, or - when the range extends up to "now" during market
 * hours - the latest stored candle is more than 2 interval-widths old
 * (today's data may have moved on).
 */
export async function ensureCandlesFresh({ exchange, symbol, interval, rangeStart, rangeEnd, groww_token }) {
  if (!SUPPORTED_INTERVALS[interval]) {
    const err = new Error(`Unsupported interval: ${interval}`)
    err.details = { error: `Unsupported interval: ${interval}`, supported: Object.keys(SUPPORTED_INTERVALS) }
    throw err
  }

  const now = new Date()
  const rangeStartTs = Math.floor(rangeStart.getTime() / 1000)
  const rangeEndTs = Math.floor(rangeEnd.getTime() / 1000)
  const nowTs = Math.floor(now.getTime() / 1000)

  const stored = await listCandlesInRange(symbol, exchange, interval, rangeStartTs, rangeEndTs)

  // Coverage, not just staleness: checking only "is the newest candle
  // recent enough" misses the case where stored data is fresh at the end
  // but doesn't reach back to the start of a range the user just widened
  // (e.g. dragged the End date further back) - that needs a fetch too.
  const earliestStoredTs = stored.length > 0 ? stored[0].timestamp : null
  const latestStoredTs = stored.length > 0 ? stored[stored.length - 1].timestamp : null
  const intervalSeconds = SUPPORTED_INTERVALS[interval] * 60
  const toleranceSeconds = intervalSeconds * 3 // a few candle-widths of slack around trading-day boundaries

  const coverageInsufficient = stored.length === 0 || earliestStoredTs - rangeStartTs > toleranceSeconds
  const staleAtRangeEnd =
    isWithinMarketHours(now) &&
    rangeEndTs >= nowTs - intervalSeconds &&
    (latestStoredTs == null || nowTs - latestStoredTs > intervalSeconds * 2)
  const needsFetch = coverageInsufficient || staleAtRangeEnd

  if (needsFetch) {
    const headers = { Authorization: `Bearer ${groww_token}`, 'X-API-VERSION': GROWW_API_VERSION, Accept: 'application/json' }
    const growwSymbol = buildGrowwSymbol(exchange, symbol)

    // Groww caps how many days one call can span (MAX_SPAN_DAYS) and errors
    // outright rather than truncating - a wide user-picked range (e.g. a
    // 2-year daily view) has to be split into consecutive sub-range calls,
    // made sequentially (not concurrent - avoid tripping Groww's own rate
    // limiting, observed firsthand while diagnosing this endpoint's
    // contract).
    const chunks = buildDateChunks(rangeStart, rangeEnd, interval)
    const fetchedChunks = []
    for (const [chunkStart, chunkEnd] of chunks) {
      const params = {
        exchange,
        segment: 'CASH',
        groww_symbol: growwSymbol,
        start_time: formatGrowwDateTime(chunkStart),
        end_time: formatGrowwDateTime(chunkEnd),
        candle_interval: interval,
      }

      let response
      try {
        response = await axios.get(`${GROWW_API_BASE_URL}/historical/candles`, { headers, params, timeout: 15000 })
      } catch (error) {
        const err = new Error('Failed to fetch historical candles')
        err.details = {
          error: 'Failed to fetch historical candles',
          message: error.message,
          groww_error: error.response?.data || null,
          status_code: error.response?.status || 500,
        }
        throw err
      }

      fetchedChunks.push(...parseGrowwCandles(response.data))
    }

    const candles = fillMissingOpens(fetchedChunks)
    if (candles.length > 0) {
      await saveCandlesBatch(symbol, exchange, interval, candles)
    }
    const refreshed = await listCandlesInRange(symbol, exchange, interval, rangeStartTs, rangeEndTs)
    return { candles: refreshed }
  }

  return { candles: stored }
}
