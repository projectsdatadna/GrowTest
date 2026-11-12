/**
 * Candle storage for the Crossover Scanner: ONE Firestore document per
 * symbol + timeframe holding the recent window of bars, instead of one
 * document per candle (what the Chart tab's `historicalCandles` cache does).
 * A scan is then 1 read + 1 write rather than hundreds of reads, which is what
 * makes ~230 symbols x 5 timeframes affordable (see the cost notes in the
 * scanner plan) and keeps busy ticks inside the function time limit.
 *
 * Stored as parallel flat arrays (t, o, h, l, c, v): Firestore rejects arrays
 * directly nested inside arrays, so [[ts, o, h, l, c, v], ...] is not an
 * option. 300 bars x 6 numbers is ~15-20KB, far under the 1MB document limit.
 *
 * Each scan fetches only the recent tail from Groww and overwrites those bars
 * by timestamp, so a bar cached while it was still forming is always replaced
 * by its final values (the staleness problem described in
 * growwHistoricalData.js's refreshRecentCandles).
 */

import admin from 'firebase-admin'
import { getFirestore } from 'firebase-admin/firestore'
import { fetchCandlesFromGroww } from './growwHistoricalData.js'

const PROJECT_ID = 'dev-cogniglob'
const DATABASE_ID = 'groww-dashboard'

if (admin.apps.length === 0) {
  admin.initializeApp({ projectId: PROJECT_ID })
}

const db = getFirestore(admin.app(), DATABASE_ID)

const WINDOWS_COLLECTION = 'scannerCandleWindows'
const DAY_MS = 24 * 60 * 60 * 1000

export function windowDocId(exchange, symbol, interval) {
  return `${exchange}_${symbol}_${interval}`
}

// The stored window for one symbol + timeframe (ascending bars), or [] when none.
export async function readCandleWindow({ exchange, symbol, interval }) {
  const snapshot = await db.collection(WINDOWS_COLLECTION).doc(windowDocId(exchange, symbol, interval)).get()
  return snapshot.exists ? decodeWindow(snapshot.data()) : []
}

export function encodeWindow(candles) {
  return {
    t: candles.map((c) => c.timestamp),
    o: candles.map((c) => c.open),
    h: candles.map((c) => c.high),
    l: candles.map((c) => c.low),
    c: candles.map((c) => c.close),
    v: candles.map((c) => c.volume ?? 0),
  }
}

export function decodeWindow(data) {
  const t = data?.t || []
  return t.map((timestamp, i) => ({ timestamp, open: data.o[i], high: data.h[i], low: data.l[i], close: data.c[i], volume: data.v[i] }))
}

/**
 * Merges freshly fetched bars over the stored window: one bar per timestamp
 * (fetched wins), ascending, then only the most recent `maxBars` kept. Pure -
 * exported so it can be replayed offline.
 */
export function mergeWindow(stored, fetched, maxBars) {
  const byTimestamp = new Map()
  for (const candle of stored) byTimestamp.set(candle.timestamp, candle)
  for (const candle of fetched) byTimestamp.set(candle.timestamp, candle)
  const merged = [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp)
  return merged.length > maxBars ? merged.slice(merged.length - maxBars) : merged
}

/**
 * Days of history to re-fetch on a normal scan: the recent `tailDays`, widened
 * to reach back to the newest stored bar when the scanner was down longer than
 * that (e.g. an expired Groww token over a few days) so the missed bars are
 * refilled instead of leaving a permanent hole. Capped at `lookbackDays`.
 * Pure - exported for offline tests.
 */
export function fetchSpanDays({ stored, tailDays, lookbackDays, now = new Date() }) {
  if (stored.length === 0) return tailDays
  const staleDays = Math.ceil((now.getTime() - stored[stored.length - 1].timestamp * 1000) / DAY_MS) + 1
  return Math.min(lookbackDays, Math.max(tailDays, staleDays))
}

/**
 * The scanner's candle loader (same contract as refreshAndLoadCandles in
 * growwHistoricalData.js, which it replaces): read the window document; if it
 * has never been backfilled, fetch the whole lookback from Groww, otherwise
 * only the recent tail; merge, prune, write back, return the bars.
 */
export async function refreshAndLoadWindow({ exchange, symbol, interval, groww_token, lookbackDays, tailDays, maxBars, now = new Date() }) {
  const ref = db.collection(WINDOWS_COLLECTION).doc(windowDocId(exchange, symbol, interval))
  const snapshot = await ref.get()
  const data = snapshot.exists ? snapshot.data() : null

  const needsBackfill = !data?.backfilledAt
  const stored = data ? decodeWindow(data) : []
  const spanDays = needsBackfill ? lookbackDays : fetchSpanDays({ stored, tailDays, lookbackDays, now })
  const rangeStart = new Date(now.getTime() - spanDays * DAY_MS)

  const fetched = await fetchCandlesFromGroww({ exchange, symbol, interval, rangeStart, rangeEnd: now, groww_token })
  const merged = mergeWindow(stored, fetched, maxBars)

  await ref.set({
    symbol,
    exchange,
    interval,
    ...encodeWindow(merged),
    count: merged.length,
    backfilledAt: data?.backfilledAt || now.toISOString(),
    updatedAt: now.toISOString(),
  })

  return { candles: merged, didBackfill: needsBackfill }
}
