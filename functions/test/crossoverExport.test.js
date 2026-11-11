import test from 'node:test'
import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'
import { buildCardRows } from '../crossoverExport.js'

const T = Date.parse('2026-11-02T09:15:00+05:30') / 1000
const card = (over = {}) => ({
  exchange: 'NSE', symbol: 'TCS', interval: '1hour', candleTimestamp: T, closePrice: 100.5, bullishCount: 1, bearishCount: 0, stars: 1, read: false,
  adx: { trend: 'increase', value: 25, prev: 20, period: 14 },
  indicators: [{ label: 'RSI 14/14', direction: 'bullish' }], ...over,
})
// columns: 0 timeframe,1 time,2 symbol,3 index,4 stars,5 bull,6 bear,7 bias,8 RSI,9 DI,10 MACD,11 TSI,12 Stoch,13 other,14 close,15 adx,16 prev,17 status,18 read

test('card row: timeframe, indicators, stars, close, ADX at the bar', () => {
  const [r] = buildCardRows([card()])
  assert.equal(r.values.length, 19)
  assert.equal(r.values[0], '1 Hour')
  assert.equal(r.values[4], '1/7')
  assert.equal(r.values[7], 'Bullish')
  assert.equal(r.values[8], 'YES - Bullish')
  assert.equal(r.values[9], 'NO')
  assert.equal(r.values[14], 100.5)
  assert.deepEqual([r.values[15], r.values[16], r.values[17], r.values[18]], [25, 20, 'Increased', 'Unread'])
  assert.ok(r.colors[8])
})

test('IST time is stored as wall-clock; 1hour bar end = 10:15 IST', () => {
  const [r] = buildCardRows([card()])
  assert.equal(r.values[1].toISOString(), '2026-11-02T10:15:00.000Z')
})

test('tie is Mixed; SMA/EMA go to Other; legacy DI label maps to DI', () => {
  const [r] = buildCardRows([card({ bullishCount: 1, bearishCount: 1, stars: 2, indicators: [{ label: 'SMA 50/200', direction: 'bearish' }, { label: 'ADX 14 (+DI/-DI)', direction: 'bearish' }] })])
  assert.equal(r.values[7], 'Mixed')
  assert.equal(r.values[13], 'SMA 50/200 Bearish')
  assert.equal(r.values[9], 'YES - Bearish')
  assert.equal(r.colors[9], 'FFD93025')
})

test('several bars / timeframes stay separate rows; index and read flags', () => {
  const rows = buildCardRows([card({ isIndex: true, read: true }), card({ candleTimestamp: T + 3600 }), card({ interval: '1day' })])
  assert.equal(rows.length, 3)
  assert.equal(rows[0].values[3], 'INDEX')
  assert.equal(rows[0].values[18], 'Read')
  assert.equal(rows[2].values[0], 'Daily')
})

test('NaN price / unknown or missing ADX become blanks', () => {
  const [a] = buildCardRows([card({ closePrice: NaN, adx: { trend: 'weird', value: NaN, prev: null } })])
  assert.deepEqual([a.values[14], a.values[15], a.values[16], a.values[17]], ['', '', '', ''])
  const [b] = buildCardRows([card({ adx: undefined })])
  assert.equal(b.values[17], '')
})
