/**
 * Fast/slow moving-average crossover - SMA ("Golden Cross"/"Death Cross")
 * or EMA, sharing one alignment helper since both are identical except for
 * which `technicalindicators` function computes each line. Unlike every
 * other crossover in this app (MACD/TSI/Stoch RSI/ADX), the two lines here
 * come from two SEPARATE calculate() calls rather than one combined
 * computation, so they're independently-lengthed arrays (the slower/longer
 * period starts later, so its output is shorter) - they need trimming to a
 * common starting candle before crossUp/crossDown can compare them, which
 * none of the single-calculation crossovers need.
 */

import { SMA, EMA, crossUp, crossDown } from 'technicalindicators'

function computeMaCrossover(candles, calculate, { fastPeriod, slowPeriod }) {
  const closes = candles.map((c) => c.close)
  const fastRaw = calculate({ period: fastPeriod, values: closes })
  const slowRaw = calculate({ period: slowPeriod, values: closes })
  if (slowRaw.length < 2) return []

  // fastRaw is the longer (earlier-starting) array whenever fastPeriod is
  // actually shorter than slowPeriod, per the class's own doc comment -
  // trim its leading values so both lines start at the same candle as
  // slowRaw, the shorter of the two.
  const fastAligned = fastRaw.slice(fastRaw.length - slowRaw.length)
  const offset = candles.length - slowRaw.length
  const usableCandles = candles.slice(offset)

  const up = crossUp({ lineA: fastAligned, lineB: slowRaw })
  const down = crossDown({ lineA: fastAligned, lineB: slowRaw })

  const events = []
  for (let i = 0; i < slowRaw.length; i++) {
    if (!up[i] && !down[i]) continue
    events.push({
      timestamp: usableCandles[i].timestamp,
      value: {
        type: up[i] ? 'bullish' : 'bearish',
        fast: fastAligned[i],
        slow: slowRaw[i],
        price: usableCandles[i].close,
      },
    })
  }
  return events
}

/**
 * @param {Array<{timestamp:number, close:number}>} candles
 * @param {{fastPeriod:number, slowPeriod:number}} params
 * @returns {Array<{timestamp:number, value:{type:'bullish'|'bearish', fast:number, slow:number, price:number}}>}
 */
export function computeSmaCrossover(candles, params) {
  return computeMaCrossover(candles, SMA.calculate, params)
}

export function computeEmaCrossover(candles, params) {
  return computeMaCrossover(candles, EMA.calculate, params)
}
