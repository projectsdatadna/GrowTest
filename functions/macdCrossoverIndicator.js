/**
 * MACD line / Signal line crossover detection - a bullish crossover is
 * where the MACD line crosses above its own Signal line (the standard MACD
 * "buy" signal), bearish is the mirror (MACD crosses below Signal). Unlike
 * RSI Divergence (technicalIndicators.js's computeRsiDivergence, a swing-
 * pair comparison hand-rolled because there's no line-crossing involved),
 * this is a literal two-line-crossing problem, so it uses the
 * `technicalindicators` package's own crossUp/crossDown utilities directly
 * rather than reimplementing crossing detection.
 */

import { MACD, crossUp, crossDown } from 'technicalindicators'

/**
 * @param {Array<{timestamp:number, close:number}>} candles
 * @param {{fastPeriod:number, slowPeriod:number, signalPeriod:number}} params
 * @returns {Array<{timestamp:number, value:{type:'bullish'|'bearish', macd:number, signal:number, price:number}}>}
 */
export function computeMacdCrossover(candles, { fastPeriod, slowPeriod, signalPeriod }) {
  const closes = candles.map((c) => c.close)
  const raw = MACD.calculate({
    values: closes,
    fastPeriod,
    slowPeriod,
    signalPeriod,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  })

  // Same gotcha as technicalIndicators.js's own 'MACD' case: the signal
  // line needs extra warm-up beyond the MACD line's, so `raw`'s first
  // several points have `signal` as undefined. crossUp/crossDown need two
  // same-length numeric arrays with no gaps, so those leading points are
  // dropped entirely rather than coalesced to a placeholder number, which
  // would fabricate a fake crossover right at the warm-up boundary.
  const offset = candles.length - raw.length
  const warmStart = raw.findIndex((p) => p.signal != null)
  if (warmStart === -1) return []

  const usable = raw.slice(warmStart)
  const usableCandles = candles.slice(offset + warmStart)
  if (usable.length < 2) return []

  const macdLine = usable.map((p) => p.MACD)
  const signalLine = usable.map((p) => p.signal)
  const up = crossUp({ lineA: macdLine, lineB: signalLine })
  const down = crossDown({ lineA: macdLine, lineB: signalLine })

  const events = []
  for (let i = 0; i < usable.length; i++) {
    if (!up[i] && !down[i]) continue
    events.push({
      timestamp: usableCandles[i].timestamp,
      value: {
        type: up[i] ? 'bullish' : 'bearish',
        macd: macdLine[i],
        signal: signalLine[i],
        price: usableCandles[i].close,
      },
    })
  }
  return events
}
