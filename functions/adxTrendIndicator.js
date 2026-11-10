/**
 * ADX trend - the real ADX (Average Directional Index, trend STRENGTH) line,
 * reported per bar as Increase / Decrease / Flat by comparing it with the
 * previous bar. Not a crossover: the scanner attaches it as context to
 * notifications, crossover groups, the Overview and the Excel export.
 * (+DI/-DI crossovers are the separate DMI indicator, dmiCrossoverIndicator.js.)
 *
 * Rule: delta = ADX[bar] - ADX[bar-1]; delta > +band -> 'increase',
 * delta < -band -> 'decrease', otherwise 'flat' (the line is effectively
 * straight).
 */

import { ADX } from 'technicalindicators'

export const ADX_TREND_PERIOD = 14
export const ADX_TREND_BAND = 0.5

const round2 = (n) => Math.round(n * 100) / 100

export function classifyAdxDelta(delta, band = ADX_TREND_BAND) {
  if (delta > band) return 'increase'
  if (delta < -band) return 'decrease'
  return 'flat'
}

/**
 * @param {Array<{timestamp:number, high:number, low:number, close:number}>} candles
 * @returns {Map<number, {period:number, value:number, prev:number, delta:number, trend:'increase'|'decrease'|'flat'}>}
 *   keyed by candle timestamp; bars without a previous ADX value are absent.
 */
export function computeAdxTrend(candles, { period = ADX_TREND_PERIOD, band = ADX_TREND_BAND } = {}) {
  const raw = ADX.calculate({
    close: candles.map((c) => c.close),
    high: candles.map((c) => c.high),
    low: candles.map((c) => c.low),
    period,
  })
  const offset = candles.length - raw.length
  const byTimestamp = new Map()
  for (let i = 1; i < raw.length; i++) {
    const value = raw[i].adx
    const prev = raw[i - 1].adx
    if (!Number.isFinite(value) || !Number.isFinite(prev)) continue
    const delta = value - prev
    byTimestamp.set(candles[offset + i].timestamp, {
      period,
      value: round2(value),
      prev: round2(prev),
      delta: round2(delta),
      trend: classifyAdxDelta(delta, band),
    })
  }
  return byTimestamp
}
