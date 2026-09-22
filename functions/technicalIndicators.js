/**
 * Technical indicator computation + on-demand freshness orchestration for
 * the Historical Chart feature, using the `technicalindicators` npm package
 * (v3.1.0 - verified live against real candle data before writing this;
 * see the two package-specific gotchas called out below).
 */

import { SMA, EMA, BollingerBands, RSI, MACD, ADX, StochasticRSI } from 'technicalindicators'
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
    case 'SR':
      if (nums.length !== 1) throw new Error(`SR expects one param (lookback), got "${spec}"`)
      return { indicator, params: { lookback: nums[0] }, paramsKey }
    case 'TSI':
      if (nums.length !== 3) throw new Error(`TSI expects three params (longPeriod:shortPeriod:signalPeriod), got "${spec}"`)
      return { indicator, params: { longPeriod: nums[0], shortPeriod: nums[1], signalPeriod: nums[2] }, paramsKey }
    case 'STOCHRSI':
      if (nums.length !== 4) throw new Error(`STOCHRSI expects four params (rsiPeriod:stochasticPeriod:kPeriod:dPeriod), got "${spec}"`)
      return { indicator, params: { rsiPeriod: nums[0], stochasticPeriod: nums[1], kPeriod: nums[2], dPeriod: nums[3] }, paramsKey }
    case 'ADX':
      if (nums.length !== 1) throw new Error(`ADX expects one param (period), got "${spec}"`)
      return { indicator, params: { period: nums[0] }, paramsKey }
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
    case 'SR':
      return computeSupportResistance(candles, { lookback: params.lookback })
    case 'TSI':
      return computeTSI(candles, params)
    case 'STOCHRSI': {
      const raw = StochasticRSI.calculate({
        values: closes,
        rsiPeriod: params.rsiPeriod,
        stochasticPeriod: params.stochasticPeriod,
        kPeriod: params.kPeriod,
        dPeriod: params.dPeriod,
      })
      return alignToTimestamps(candles, raw).map((point) => ({
        timestamp: point.timestamp,
        value: { stochRsi: point.value.stochRSI, k: point.value.k, d: point.value.d },
      }))
    }
    case 'ADX': {
      const raw = ADX.calculate({
        close: closes,
        high: candles.map((c) => c.high),
        low: candles.map((c) => c.low),
        period: params.period,
      })
      return alignToTimestamps(candles, raw).map((point) => ({
        timestamp: point.timestamp,
        value: { adx: point.value.adx, pdi: point.value.pdi, mdi: point.value.mdi },
      }))
    }
    default:
      throw new Error(`Unsupported indicator: ${indicator}`)
  }
}

// True Strength Index (Blau) - not in the `technicalindicators` package, so
// hand-implemented here reusing its EMA for the actual smoothing math: a
// double-EMA'd (longPeriod then shortPeriod) momentum series divided by the
// same double-EMA'd absolute-momentum series, times 100, plus a conventional
// EMA signal line over the TSI series itself (same line+signal pairing the
// MACD case above already uses). Momentum and abs-momentum start from the
// same-length array and go through identical smoothing, so they always come
// out the same length as each other - only the signal EMA is shorter (by
// signalPeriod-1), padded with `null` for the gap (same technique MACD's own
// case uses for its shorter signal leg - Firestore rejects `undefined`).
function computeTSI(candles, { longPeriod, shortPeriod, signalPeriod }) {
  const closes = candles.map((c) => c.close)
  const momentum = []
  const absMomentum = []
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1]
    momentum.push(diff)
    absMomentum.push(Math.abs(diff))
  }

  const smoothedMomentum = EMA.calculate({ period: shortPeriod, values: EMA.calculate({ period: longPeriod, values: momentum }) })
  const smoothedAbsMomentum = EMA.calculate({ period: shortPeriod, values: EMA.calculate({ period: longPeriod, values: absMomentum }) })
  const tsiValues = smoothedMomentum.map((m, i) => (smoothedAbsMomentum[i] === 0 ? 0 : (100 * m) / smoothedAbsMomentum[i]))

  const signalValues = EMA.calculate({ period: signalPeriod, values: tsiValues })
  const signalOffset = tsiValues.length - signalValues.length

  // tsiValues is a plain suffix of `candles` (via the momentum diff + two
  // EMA passes), so it aligns the same way every other indicator's output
  // does - alignToTimestamps expects candles.length - values.length as the
  // offset, which holds here too.
  return alignToTimestamps(candles, tsiValues).map((point, i) => ({
    timestamp: point.timestamp,
    value: { tsi: point.value, signal: i >= signalOffset ? signalValues[i - signalOffset] : null },
  }))
}

// Scripted (non-AI) Support/Resistance via swing-point clustering:
// 1. Fractal swing detection - bar i is a swing high if its high is the max
//    among the `lookback` bars on either side (swing low is the symmetric
//    case on lows). Unlike every other indicator here, the output isn't a
//    per-candle-aligned series - swing points are scattered wherever they
//    occurred, not a fixed-offset suffix of `candles` - so this bypasses
//    alignToTimestamps entirely.
// 2. Cluster nearby levels - sort swing prices, greedily merge any price
//    within mergeTolerancePct% of the running cluster's average into that
//    cluster, tracking touch count and most recent timestamp.
// 3. Rank by touches (then recency), split into support/resistance by
//    whether the level sits below/above the latest close, keep the top
//    maxLevels per side.
function computeSupportResistance(candles, { lookback = 5, mergeTolerancePct = 0.5, maxLevels = 6 } = {}) {
  if (candles.length < lookback * 2 + 1) return []

  const swings = []
  for (let i = lookback; i < candles.length - lookback; i++) {
    const window = candles.slice(i - lookback, i + lookback + 1)
    if (window.every((c) => candles[i].high >= c.high)) swings.push({ price: candles[i].high, timestamp: candles[i].timestamp })
    if (window.every((c) => candles[i].low <= c.low)) swings.push({ price: candles[i].low, timestamp: candles[i].timestamp })
  }
  if (swings.length === 0) return []

  const sorted = [...swings].sort((a, b) => a.price - b.price)
  const clusters = []
  for (const swing of sorted) {
    const last = clusters[clusters.length - 1]
    if (last && (Math.abs(swing.price - last.avgPrice) / last.avgPrice) * 100 <= mergeTolerancePct) {
      last.touches += 1
      last.priceSum += swing.price
      last.avgPrice = last.priceSum / last.touches
      last.lastTimestamp = Math.max(last.lastTimestamp, swing.timestamp)
    } else {
      clusters.push({ avgPrice: swing.price, priceSum: swing.price, touches: 1, lastTimestamp: swing.timestamp })
    }
  }

  const latestClose = candles[candles.length - 1].close
  const ranked = clusters
    .map((c) => ({
      timestamp: c.lastTimestamp,
      value: { type: c.avgPrice < latestClose ? 'support' : 'resistance', price: c.avgPrice, touches: c.touches },
    }))
    .sort((a, b) => b.value.touches - a.value.touches || b.timestamp - a.timestamp)

  const support = ranked.filter((r) => r.value.type === 'support').slice(0, maxLevels)
  const resistance = ranked.filter((r) => r.value.type === 'resistance').slice(0, maxLevels)
  return [...support, ...resistance].sort((a, b) => a.timestamp - b.timestamp)
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
