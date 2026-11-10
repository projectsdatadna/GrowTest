/**
 * RSI / RSI-based-MA crossover detection - RSI(rsiPeriod) crossing its own
 * SMA(maPeriod), the same pairing as TradingView's default RSI indicator
 * ("RSI-based MA", SMA length 14). Bullish = RSI crosses above its MA,
 * bearish = the mirror. Same line-vs-signal shape as
 * macdCrossoverIndicator.js, using the package's own crossUp/crossDown.
 */

import { RSI, SMA, crossUp, crossDown } from 'technicalindicators'

/**
 * @param {Array<{timestamp:number, close:number}>} candles
 * @param {{rsiPeriod:number, maPeriod:number}} params
 * @returns {Array<{timestamp:number, value:{type:'bullish'|'bearish', rsi:number, ma:number, price:number}}>}
 */
export function computeRsiCrossover(candles, { rsiPeriod, maPeriod }) {
  const rsi = RSI.calculate({ period: rsiPeriod, values: candles.map((c) => c.close) })
  const ma = SMA.calculate({ period: maPeriod, values: rsi })
  if (ma.length < 2) return []

  // Right-align both series onto the candles: the MA is shorter than the RSI
  // by maPeriod-1, and the RSI shorter than the candles by rsiPeriod.
  const rsiLine = rsi.slice(rsi.length - ma.length)
  const usableCandles = candles.slice(candles.length - ma.length)
  const up = crossUp({ lineA: rsiLine, lineB: ma })
  const down = crossDown({ lineA: rsiLine, lineB: ma })

  const events = []
  for (let i = 0; i < ma.length; i++) {
    if (!up[i] && !down[i]) continue
    events.push({
      timestamp: usableCandles[i].timestamp,
      value: { type: up[i] ? 'bullish' : 'bearish', rsi: rsiLine[i], ma: ma[i], price: usableCandles[i].close },
    })
  }
  return events
}
