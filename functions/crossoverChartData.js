/**
 * Data for the hover chart on a Notifications card: the candles the scanner
 * itself stored (scannerCandleWindows) around the crossover bar, plus every
 * series needed to draw the card's indicators. Indicators are computed over the
 * WHOLE stored window - exactly what the scanner did - and only then cut to the
 * display range, so values at the crossover bar match the notification.
 *
 * Series are keyed the way the Historical Chart component reads them
 * (src/components/HistoricalCandlestickChart.jsx): plain series ("MACD:12:26:9"),
 * crossover events ("MACDCROSS:12:26:9"), "ADXCROSS:<p>" for DMICROSS (the chart's
 * name for the +DI/-DI crossover), and "RSIMA:<rsi>:<ma>" (RSI's moving average,
 * derived here).
 */

import { computeIndicatorSpec } from './technicalIndicators.js'
import { CROSSOVER_SPECS } from './crossoverScanner.js'
import { candleEnd, isCandleClosed } from './crossoverTimeframes.js'

export const ADX_CHART_SPEC = 'ADX:14'
const BARS_BEFORE = 100
const BARS_AFTER = 10

const ALLOWED_SPECS = new Set(CROSSOVER_SPECS.map((s) => s.spec))

// crossover spec -> the chart series it needs ([plain series..., crossover key]).
export function seriesSpecsFor(crossoverSpec) {
  const [name, ...p] = crossoverSpec.split(':')
  switch (name) {
    case 'MACDCROSS':
      return { plain: [`MACD:${p.join(':')}`], cross: crossoverSpec }
    case 'TSICROSS':
      return { plain: [`TSI:${p.join(':')}`], cross: crossoverSpec }
    case 'STOCHRSICROSS':
      return { plain: [`STOCHRSI:${p.join(':')}`], cross: crossoverSpec }
    case 'DMICROSS':
      return { plain: [`ADX:${p[0]}`], cross: crossoverSpec, crossKey: `ADXCROSS:${p[0]}` }
    case 'RSICROSS':
      return { plain: [`RSI:${p[0]}`], cross: crossoverSpec, derived: [`RSIMA:${p[0]}:${p[1]}`] }
    case 'SMACROSS':
      return { plain: [`SMA:${p[0]}`, `SMA:${p[1]}`], cross: crossoverSpec }
    case 'EMACROSS':
      return { plain: [`EMA:${p[0]}`, `EMA:${p[1]}`], cross: crossoverSpec }
    default:
      throw new Error(`Unsupported crossover spec ${crossoverSpec}`)
  }
}

// Simple moving average of a {timestamp, value:number} series (null until `period` points).
export function smaOfSeries(points, period) {
  const out = []
  let sum = 0
  points.forEach((point, i) => {
    sum += point.value
    if (i >= period) sum -= points[i - period].value
    if (i >= period - 1) out.push({ timestamp: point.timestamp, value: sum / period })
  })
  return out
}

// Same input the scanner feeds its indicators: one bar per timestamp, only closed
// real trading bars (a forming bar is provisional; Groww's stray 15:45 bar is not
// a trading bar). Anything else would shift every later indicator value.
export function closedCandles(candles, interval, nowSeconds) {
  const byTimestamp = new Map()
  for (const candle of candles) byTimestamp.set(candle.timestamp, candle)
  return [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp).filter((c) => isCandleClosed(interval, c.timestamp, nowSeconds))
}

/**
 * candles: the full stored window (ascending). Returns {candles, series,
 * crossoverTimestamp, crossoverEnd} or {error} when the crossover bar is no
 * longer inside the stored window.
 */
export function buildCrossoverChart({ candles: stored, interval, crossoverTimestamp, specs, nowSeconds = Math.floor(Date.now() / 1000) }) {
  const candles = closedCandles(stored, interval, nowSeconds)
  const bad = specs.find((s) => !ALLOWED_SPECS.has(s))
  if (bad) return { error: `Unsupported indicator ${bad}` }
  const index = candles.findIndex((c) => c.timestamp === crossoverTimestamp)
  if (index < 0) return { error: 'This crossover bar is older than the stored candles, so its chart is no longer available.' }

  const full = {}
  const wanted = new Set([ADX_CHART_SPEC])
  for (const spec of specs) {
    const needs = seriesSpecsFor(spec)
    needs.plain.forEach((s) => wanted.add(s))
    full[needs.crossKey || needs.cross] = computeIndicatorSpec(needs.cross, candles)
  }
  for (const spec of wanted) full[spec] = computeIndicatorSpec(spec, candles)
  for (const spec of specs) {
    for (const derived of seriesSpecsFor(spec).derived || []) {
      const [, rsiPeriod, maPeriod] = derived.split(':')
      full[derived] = smaOfSeries(full[`RSI:${rsiPeriod}`], Number(maPeriod))
    }
  }

  const start = Math.max(0, index - BARS_BEFORE)
  const end = Math.min(candles.length, index + BARS_AFTER + 1)
  const from = candles[start].timestamp
  const to = candles[end - 1].timestamp
  const series = Object.fromEntries(Object.entries(full).map(([key, points]) => [key, points.filter((p) => p.timestamp >= from && p.timestamp <= to)]))
  return { candles: candles.slice(start, end), series, crossoverTimestamp, crossoverEnd: candleEnd(interval, crossoverTimestamp) }
}
