/**
 * Stoch RSI %K / %D crossover detection - the classic Stochastic-family
 * momentum-turn signal, same shape as macdCrossoverIndicator.js's MACD/
 * Signal cross. Unlike MACD's signal line or TSI's own signal line,
 * StochasticRSI.calculate()'s `k`/`d` come back fully populated with no
 * leading null/undefined gap (verified live against real candle data,
 * same diligence technicalIndicators.js's own gotcha comments follow) - so
 * no warm-up trim is needed here before crossUp/crossDown.
 */

import { StochasticRSI, crossUp, crossDown } from 'technicalindicators'

/**
 * @param {Array<{timestamp:number, close:number}>} candles
 * @param {{rsiPeriod:number, stochasticPeriod:number, kPeriod:number, dPeriod:number}} params
 * @returns {Array<{timestamp:number, value:{type:'bullish'|'bearish', k:number, d:number, price:number}}>}
 */
export function computeStochRsiCrossover(candles, { rsiPeriod, stochasticPeriod, kPeriod, dPeriod }) {
  const closes = candles.map((c) => c.close)
  const raw = StochasticRSI.calculate({ values: closes, rsiPeriod, stochasticPeriod, kPeriod, dPeriod })
  if (raw.length < 2) return []

  const offset = candles.length - raw.length
  const usableCandles = candles.slice(offset)

  const kLine = raw.map((p) => p.k)
  const dLine = raw.map((p) => p.d)
  const up = crossUp({ lineA: kLine, lineB: dLine })
  const down = crossDown({ lineA: kLine, lineB: dLine })

  const events = []
  for (let i = 0; i < raw.length; i++) {
    if (!up[i] && !down[i]) continue
    events.push({
      timestamp: usableCandles[i].timestamp,
      value: {
        type: up[i] ? 'bullish' : 'bearish',
        k: kLine[i],
        d: dLine[i],
        price: usableCandles[i].close,
      },
    })
  }
  return events
}
