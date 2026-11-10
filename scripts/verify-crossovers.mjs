#!/usr/bin/env node
/**
 * Offline checks for the scanner indicators and crossover groups (no Groww,
 * no Firestore writes - candles and persistence are injected).
 *
 *   node scripts/verify-crossovers.mjs
 */
import assert from 'node:assert/strict'
import { computeIndicatorSpec, parseIndicatorSpec } from '../functions/technicalIndicators.js'
import { computeAdxTrend, classifyAdxDelta } from '../functions/adxTrendIndicator.js'
import { scanSymbolInterval, buildCrossoverGroups, CROSSOVER_SPECS } from '../functions/crossoverScanner.js'
import { candleEnd } from '../functions/crossoverTimeframes.js'

// Deterministic pseudo-random candles (15-minute bars, trading hours only).
function makeCandles(count, seed = 7) {
  let x = seed
  const rand = () => ((x = (x * 16807) % 2147483647) / 2147483647)
  const candles = []
  let price = 1000
  let t = Date.UTC(2025, 9, 1, 3, 45) / 1000 // 09:15 IST
  while (candles.length < count) {
    const istMinutes = ((t / 60 + 330) % 1440)
    const day = new Date((t + 19800) * 1000).getUTCDay()
    if (day !== 0 && day !== 6 && istMinutes >= 555 && istMinutes < 930) {
      const open = price
      price = Math.max(10, price + Math.sin(candles.length / 9) * 4 + (rand() - 0.5) * 8)
      candles.push({ timestamp: t, open, high: Math.max(open, price) + rand() * 3, low: Math.min(open, price) - rand() * 3, close: price, volume: 1000 })
    }
    t += 900
  }
  return candles
}
const candles = makeCandles(600)

// 1. DMI rename is behaviour-preserving; legacy spec still parses.
assert.deepEqual(computeIndicatorSpec('DMICROSS:14', candles), computeIndicatorSpec('ADXCROSS:14', candles))
assert.equal(parseIndicatorSpec('ADXCROSS:14').indicator, 'ADXCROSS')
console.log(`✓ DMICROSS:14 == ADXCROSS:14 (${computeIndicatorSpec('DMICROSS:14', candles).length} events); ADXCROSS alias parses`)

// 2. ADX trend rule.
assert.equal(classifyAdxDelta(0.6), 'increase')
assert.equal(classifyAdxDelta(-0.6), 'decrease')
assert.equal(classifyAdxDelta(0.3), 'flat')
assert.equal(classifyAdxDelta(-0.5), 'flat')
const adxSeries = computeIndicatorSpec('ADX:14', candles)
const trend = computeAdxTrend(candles)
const last = adxSeries.at(-1)
const prev = adxSeries.at(-2)
const got = trend.get(last.timestamp)
assert.equal(got.value, Math.round(last.value.adx * 100) / 100)
assert.equal(got.prev, Math.round(prev.value.adx * 100) / 100)
assert.equal(got.trend, classifyAdxDelta(last.value.adx - prev.value.adx))
console.log(`✓ ADX trend: latest ${got.value} vs ${got.prev} -> ${got.trend}; matches the ADX:14 series`)

// 3. RSI crossover vs an independent hand computation (Wilder RSI + SMA 14).
function wilderRsi(closes, period) {
  const out = []
  let gain = 0
  let loss = 0
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1]
    gain += Math.max(d, 0)
    loss += Math.max(-d, 0)
  }
  gain /= period
  loss /= period
  out[period] = 100 - 100 / (1 + gain / loss)
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    gain = (gain * (period - 1) + Math.max(d, 0)) / period
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period
    out[i] = 100 - 100 / (1 + gain / loss)
  }
  return out
}
const closes = candles.map((c) => c.close)
const rsi = wilderRsi(closes, 14)
const ma = rsi.map((_, i) => (i >= 27 ? rsi.slice(i - 13, i + 1).reduce((a, b) => a + b, 0) / 14 : undefined))
const manual = []
for (let i = 28; i < closes.length; i++) {
  const before = rsi[i - 1] - ma[i - 1]
  const now = rsi[i] - ma[i]
  if (before <= 0 && now > 0) manual.push({ t: candles[i].timestamp, type: 'bullish' })
  if (before >= 0 && now < 0) manual.push({ t: candles[i].timestamp, type: 'bearish' })
}
const lib = computeIndicatorSpec('RSICROSS:14:14', candles).map((e) => ({ t: e.timestamp, type: e.value.type }))
// The library rounds RSI to 2 decimals, so a near-touch can differ; require >= 95% agreement.
const libKeys = new Set(lib.map((e) => `${e.t}:${e.type}`))
const agree = manual.filter((e) => libKeys.has(`${e.t}:${e.type}`)).length
assert.ok(lib.length > 0 && agree / Math.max(manual.length, lib.length) >= 0.95, `RSI cross agreement ${agree}/${manual.length} vs ${lib.length}`)
console.log(`✓ RSICROSS:14:14: ${lib.length} events, ${agree}/${manual.length} identical to the hand computation`)

// 4. Groups: merge per bar, stars = distinct indicators, bias, ordering of indicators.
const groups = buildCrossoverGroups(
  [
    { symbol: 'HDFCBANK', exchange: 'NSE', interval: '1hour', timeframeLabel: '1 hour', indicatorLabel: 'TSI 25/13/13', spec: 'TSICROSS:25:13:13', direction: 'bullish', candleTimestamp: 100, closePrice: 1, lines: {}, id: 'a', adx: { value: 20, prev: 19, trend: 'increase' } },
    { symbol: 'HDFCBANK', exchange: 'NSE', interval: '1hour', timeframeLabel: '1 hour', indicatorLabel: 'MACD 12/26/9', spec: 'MACDCROSS:12:26:9', direction: 'bullish', candleTimestamp: 100, closePrice: 1, lines: {}, id: 'b' },
    { symbol: 'HDFCBANK', exchange: 'NSE', interval: '1hour', timeframeLabel: '1 hour', indicatorLabel: 'DMI 14 (+DI/-DI)', spec: 'DMICROSS:14', direction: 'bearish', candleTimestamp: 100, closePrice: 1, lines: {}, id: 'c' },
    { symbol: 'HDFCBANK', exchange: 'NSE', interval: '1hour', timeframeLabel: '1 hour', indicatorLabel: 'MACD 12/26/9', spec: 'MACDCROSS:12:26:9', direction: 'bearish', candleTimestamp: 200, closePrice: 2, lines: {}, id: 'd' },
  ],
  { isIndex: false, sortOrder: 10 }
)
assert.equal(groups.length, 2)
const g = groups.find((x) => x.candleTimestamp === 100)
assert.equal(g.stars, 3)
assert.deepEqual([g.bullishCount, g.bearishCount, g.bias, g.hasBullish, g.hasBearish], [2, 1, 'bullish', true, true])
assert.deepEqual(g.indicatorLabels, ['MACD 12/26/9', 'TSI 25/13/13', 'DMI 14 (+DI/-DI)'], 'indicators in CROSSOVER_SPECS order')
assert.deepEqual(g.notificationIds, ['b', 'a', 'c'])
assert.equal(g.adx.trend, 'increase')
console.log('✓ groups: one per bar, 3★ with ▲2 ▼1, indicators in spec order')

// 5. Full scan with injected candles: groups written per bar, summary.adx set.
// Cut the series at the bar with the most indicators crossing, so the scan has
// a multi-indicator group to write.
const hits = new Map()
for (const def of CROSSOVER_SPECS) for (const e of computeIndicatorSpec(def.spec, candles)) hits.set(e.timestamp, (hits.get(e.timestamp) || 0) + 1)
const [bestTs, bestCount] = [...hits.entries()].filter(([t]) => t > candles[300].timestamp).sort((x, y) => y[1] - x[1])[0]
const scanCandles = candles.slice(0, candles.findIndex((c) => c.timestamp === bestTs) + 1)
const lastBar = scanCandles.at(-1)
const now = new Date((candleEnd('15minute', lastBar.timestamp) + 60) * 1000)
const alerts = []
const written = []
const result = await scanSymbolInterval({
  symbol: 'NIFTY',
  exchange: 'NSE',
  interval: '15minute',
  now,
  state: { lastBarEnd: candleEnd('15minute', scanCandles.at(-4).timestamp), backfilledAt: 'x' },
  isIndex: true,
  sortOrder: 0,
  loadCandles: async () => ({ candles: scanCandles, didBackfill: false }),
  persistAlert: async (id, fields) => (alerts.push({ id, ...fields }), true),
  persistGroup: async (id, group) => written.push({ id, ...group }),
})
assert.equal(result.status, 'scanned')
assert.ok(result.statePatch.summary.adx?.trend, 'summary.adx recorded')
assert.equal(CROSSOVER_SPECS.length, 7)
const bars = new Set(alerts.map((a) => a.candleTimestamp))
assert.ok(bars.has(bestTs), 'the cut bar alerted')
assert.equal(written.find((w) => w.candleTimestamp === bestTs).stars, bestCount, `${bestCount} indicators crossed on the cut bar`)
assert.equal(written.length, bars.size, 'one group per alerted bar')
assert.ok(written.every((w) => w.isIndex === true && w.sortOrder === 0 && w.id.startsWith('xg_NSE_NIFTY_15minute_')))
assert.equal(written.reduce((n, w) => n + w.indicators.length, 0), alerts.length, 'every alert lands in exactly one group')
assert.ok(alerts.every((a) => a.adx === null || ['increase', 'decrease', 'flat'].includes(a.adx.trend)))
console.log(`✓ scan: ${alerts.length} alert(s) over ${bars.size} bar(s) -> ${written.length} group(s); summary.adx = ${JSON.stringify(result.statePatch.summary.adx)}`)
console.log('All crossover checks passed.')
