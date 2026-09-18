/**
 * Technical indicator computation + on-demand freshness orchestration for
 * the Historical Chart feature, using the `technicalindicators` npm package
 * (v3.1.0 - verified live against real candle data before writing this;
 * see the two package-specific gotchas called out below).
 */

import { SMA, EMA, BollingerBands, RSI, MACD } from 'technicalindicators'
import { saveIndicatorSeriesBatch } from './historicalDataFirestoreClient.js'

// "SMA:20" -> {indicator:'SMA', params:{period:20}, paramsKey:'20'}
// "BB:20:2" -> {indicator:'BB', params:{period:20,stdDev:2}, paramsKey:'20:2'}
// "MACD:12:26:9" -> {indicator:'MACD', params:{fastPeriod:12,slowPeriod:26,signalPeriod:9}, paramsKey:'12:26:9'}
export function parseIndicatorSpec(spec) {
  const [indicator, ...paramParts] = String(spec).split(':')
  const nums = paramParts.map(Number)
  const paramsKey = paramParts.join(':')

  if (nums.some((n) => !Number.isFinite(n) || n <= 0)) {
    throw new Error(`Invalid indicator spec: "${spec}" - expected positive numeric params`)
  }

  switch (indicator) {
    case 'SMA':
    case 'EMA':
    case 'RSI':
      if (nums.length !== 1) throw new Error(`${indicator} expects one param (period), got "${spec}"`)
      return { indicator, params: { period: nums[0] }, paramsKey }
    case 'BB':
      if (nums.length !== 2) throw new Error(`BB expects two params (period:stdDev), got "${spec}"`)
      return { indicator, params: { period: nums[0], stdDev: nums[1] }, paramsKey }
    case 'MACD':
      if (nums.length !== 3) throw new Error(`MACD expects three params (fastPeriod:slowPeriod:signalPeriod), got "${spec}"`)
      return { indicator, params: { fastPeriod: nums[0], slowPeriod: nums[1], signalPeriod: nums[2] }, paramsKey }
    default:
      throw new Error(`Unsupported indicator: ${indicator}`)
  }
}

// Right-aligns a shorter indicator-output array back onto the (longer)
// candles array by the length difference, rather than a hardcoded warm-up
// constant per indicator/params - verified live that different indicators
// drop different numbers of leading candles (SMA/EMA/BB drop period-1,
// RSI drops exactly `period`), so deriving the offset keeps this correct
// regardless of which indicator/params is being aligned.
function alignToTimestamps(candles, values) {
  const offset = candles.length - values.length
  return values.map((value, i) => ({ timestamp: candles[offset + i].timestamp, value }))
}

function computeIndicator(indicator, params, candles) {
  const closes = candles.map((c) => c.close)

  switch (indicator) {
    case 'SMA':
      return alignToTimestamps(candles, SMA.calculate({ period: params.period, values: closes }))
    case 'EMA':
      return alignToTimestamps(candles, EMA.calculate({ period: params.period, values: closes }))
    case 'RSI':
      return alignToTimestamps(candles, RSI.calculate({ period: params.period, values: closes }))
    case 'BB': {
      const raw = BollingerBands.calculate({ period: params.period, stdDev: params.stdDev, values: closes })
      // technicalindicators also returns a `pb` (percent-B) field we don't
      // use - keep only the three band values the plan/frontend expect.
      return alignToTimestamps(candles, raw).map((point) => ({
        timestamp: point.timestamp,
        value: { upper: point.value.upper, middle: point.value.middle, lower: point.value.lower },
      }))
    }
    case 'MACD': {
      const raw = MACD.calculate({
        values: closes,
        fastPeriod: params.fastPeriod,
        slowPeriod: params.slowPeriod,
        signalPeriod: params.signalPeriod,
        SimpleMAOscillator: false,
        SimpleMASignal: false,
      })
      // Verified live: the signal line needs its own extra warm-up beyond
      // the MACD line's, so the first several points in `raw` have
      // `signal`/`histogram` as `undefined` (only `MACD` is set). Firestore
      // rejects writing `undefined` field values outright, so this must
      // coalesce to `null` explicitly - not optional cleanup.
      return alignToTimestamps(candles, raw).map((point) => ({
        timestamp: point.timestamp,
        value: {
          macd: point.value.MACD ?? null,
          signal: point.value.signal ?? null,
          histogram: point.value.histogram ?? null,
        },
      }))
    }
    default:
      throw new Error(`Unsupported indicator: ${indicator}`)
  }
}

/**
 * Computes this indicator spec fresh from the given (already-fetched)
 * candles and upserts it to Firestore, then returns it.
 *
 * Always recomputes rather than checking "is the stored series fresh
 * enough" first - unlike ensureCandlesFresh's Groww fetch, indicator math
 * over an in-memory candle array is cheap (microseconds for a few hundred
 * points), so there's nothing worth skipping. A first version tried to
 * skip recomputation whenever the stored series' newest point was already
 * as new as the latest candle - but that only checked staleness, not
 * coverage: a series computed once from a SMALLER candle window (e.g. the
 * user later drags the count slider up) can have a perfectly fresh newest
 * point while still being far too short, and that stale-but-"fresh" short
 * series would keep getting served forever. Firestore here is purely a
 * write-cache for any future consumer that doesn't have `candles` in
 * memory - not a read-side shortcut for this call.
 */
export async function ensureIndicatorFresh({ symbol, exchange, interval, spec, candles }) {
  const { indicator, params, paramsKey } = parseIndicatorSpec(spec)
  if (candles.length === 0) return []

  const points = computeIndicator(indicator, params, candles)
  if (points.length > 0) {
    await saveIndicatorSeriesBatch(symbol, exchange, interval, indicator, paramsKey, points)
  }
  return points
}
