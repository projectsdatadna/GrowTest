import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCrossoverChart } from '../crossoverChartData.js'
import { CROSSOVER_SPECS } from '../crossoverScanner.js'

test('chart payload carries every indicator series so any checkbox can be ticked', () => {
  const start = Date.parse('2024-01-01T00:00:00+05:30') / 1000
  const candles = Array.from({ length: 320 }, (_, i) => {
    const close = 100 + 10 * Math.sin(i / 7) + i * 0.05
    return { timestamp: start + i * 86400, open: close - 1, high: close + 2, low: close - 2, close, volume: 1000 }
  })
  const specs = CROSSOVER_SPECS.map((s) => s.spec)
  const chart = buildCrossoverChart({ candles, interval: '1day', crossoverTimestamp: candles[250].timestamp, specs, nowSeconds: start + 400 * 86400 })
  assert.equal(chart.error, undefined)
  for (const key of ['MACD:12:26:9', 'TSI:25:13:13', 'STOCHRSI:14:14:3:3', 'ADX:14', 'RSI:14', 'RSIMA:14:14', 'SMA:50', 'SMA:200', 'EMA:12', 'EMA:26', 'MACDCROSS:12:26:9', 'ADXCROSS:14']) {
    assert.ok(Array.isArray(chart.series[key]) && chart.series[key].length > 0, `${key} missing`)
  }
})
