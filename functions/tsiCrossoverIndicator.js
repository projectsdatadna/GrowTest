/**
 * TSI line / Signal line crossover detection - same shape as
 * macdCrossoverIndicator.js's MACD/Signal cross, just against TSI's own
 * line+signal pair instead. Reuses technicalIndicators.js's own computeTSI
 * (exported for exactly this reuse) rather than reimplementing TSI's
 * double-EMA math here - that function already returns candle-aligned
 * `{timestamp, value:{tsi, signal}}` points, with `signal` padded `null`
 * for its own leading warm-up gap (documented on computeTSI itself).
 */

import { crossUp, crossDown } from 'technicalindicators'
import { computeTSI } from './technicalIndicators.js'

/**
 * @param {Array<{timestamp:number, close:number}>} candles
 * @param {{longPeriod:number, shortPeriod:number, signalPeriod:number}} params
 * @returns {Array<{timestamp:number, value:{type:'bullish'|'bearish', tsi:number, signal:number, price:number}}>}
 */
export function computeTsiCrossover(candles, { longPeriod, shortPeriod, signalPeriod }) {
  const tsiPoints = computeTSI(candles, { longPeriod, shortPeriod, signalPeriod })
  const offset = candles.length - tsiPoints.length

  // Same gotcha as MACD's own signal line: the signal EMA needs extra
  // warm-up beyond the TSI line's, so the first several points have
  // `signal` as null. Drop those leading points entirely rather than
  // coalescing to a placeholder, which would fabricate a fake crossover
  // right at the warm-up boundary.
  const warmStart = tsiPoints.findIndex((p) => p.value.signal != null)
  if (warmStart === -1) return []

  const usable = tsiPoints.slice(warmStart)
  const usableCandles = candles.slice(offset + warmStart)
  if (usable.length < 2) return []

  const tsiLine = usable.map((p) => p.value.tsi)
  const signalLine = usable.map((p) => p.value.signal)
  const up = crossUp({ lineA: tsiLine, lineB: signalLine })
  const down = crossDown({ lineA: tsiLine, lineB: signalLine })

  const events = []
  for (let i = 0; i < usable.length; i++) {
    if (!up[i] && !down[i]) continue
    events.push({
      timestamp: usableCandles[i].timestamp,
      value: {
        type: up[i] ? 'bullish' : 'bearish',
        tsi: tsiLine[i],
        signal: signalLine[i],
        price: usableCandles[i].close,
      },
    })
  }
  return events
}
