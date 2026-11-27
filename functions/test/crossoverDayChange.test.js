import test from 'node:test'
import assert from 'node:assert/strict'
import { computeDayChange } from '../crossoverDayChange.js'

const IST = 19800
const DAY = 86400
// 2025-01-06 (Mon) 00:00 IST in epoch seconds
const MON = Date.UTC(2025, 0, 6) / 1000 - IST
const daily = (dayOffset, close) => ({ timestamp: MON + dayOffset * DAY, close })

test('uses the previous trading day close (skips weekend)', () => {
  const dailyCandles = [daily(-3, 100), daily(-2, 101)] // Fri 3 Jan, Sat 4 Jan (stand-in)
  const r = computeDayChange({ closePrice: 103.03, candleTimestamp: MON + 9 * 3600 + 15 * 60, interval: '15minute', dailyCandles: [daily(-3, 100)] })
  assert.deepEqual(r, { prevClose: 100, dayChange: 3.03, dayChangePct: 3.03 })
  assert.equal(computeDayChange({ closePrice: 1, candleTimestamp: MON + 34200, interval: '15minute', dailyCandles }).prevClose, 101)
})

test("ignores today's own daily bar", () => {
  const r = computeDayChange({ closePrice: 110, candleTimestamp: MON + 40000, interval: '15minute', dailyCandles: [daily(-3, 100), daily(0, 108)] })
  assert.equal(r.prevClose, 100)
  assert.equal(r.dayChangePct, 10)
})

test('negative change and daily card use previous day', () => {
  const r = computeDayChange({ closePrice: 95, candleTimestamp: MON, interval: '1day', dailyCandles: [daily(-3, 100), daily(0, 95)] })
  assert.deepEqual(r, { prevClose: 100, dayChange: -5, dayChangePct: -5 })
})

test('missing data returns null', () => {
  assert.equal(computeDayChange({ closePrice: 10, candleTimestamp: MON, interval: '1day', dailyCandles: [] }), null)
  assert.equal(computeDayChange({ closePrice: null, candleTimestamp: MON, interval: '1day', dailyCandles: [daily(-3, 1)] }), null)
})
