/**
 * ADX +DI / -DI crossover detection - the standard trend-direction-flip
 * signal (+DI crossing above -DI = bullish, the mirror = bearish), same
 * shape as macdCrossoverIndicator.js's MACD/Signal cross. ADX.calculate()'s
 * `pdi`/`mdi` come back fully populated with no leading null/undefined gap
 * (verified live against real candle data, same diligence
 * technicalIndicators.js's own gotcha comments follow) - so no warm-up trim
 * is needed here before crossUp/crossDown.
 */

import { ADX, crossUp, crossDown } from 'technicalindicators'

/**
 * @param {Array<{timestamp:number, high:number, low:number, close:number}>} candles
 * @param {{period:number}} params
 * @returns {Array<{timestamp:number, value:{type:'bullish'|'bearish', pdi:number, mdi:number, price:number}}>}
 */
export function computeAdxCrossover(candles, { period }) {
  const raw = ADX.calculate({
    close: candles.map((c) => c.close),
    high: candles.map((c) => c.high),
    low: candles.map((c) => c.low),
    period,
  })
  if (raw.length < 2) return []

  const offset = candles.length - raw.length
  const usableCandles = candles.slice(offset)

  const pdiLine = raw.map((p) => p.pdi)
  const mdiLine = raw.map((p) => p.mdi)
  const up = crossUp({ lineA: pdiLine, lineB: mdiLine })
  const down = crossDown({ lineA: pdiLine, lineB: mdiLine })

  const events = []
  for (let i = 0; i < raw.length; i++) {
    if (!up[i] && !down[i]) continue
    events.push({
      timestamp: usableCandles[i].timestamp,
      value: {
        type: up[i] ? 'bullish' : 'bearish',
        pdi: pdiLine[i],
        mdi: mdiLine[i],
        price: usableCandles[i].close,
      },
    })
  }
  return events
}
