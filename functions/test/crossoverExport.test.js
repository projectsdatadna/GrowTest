import test from 'node:test'
import assert from 'node:assert/strict'
import { buildExportRows, renderWorkbook } from '../crossoverExport.js'

const ts = (d) => Date.parse(`${d}+05:30`) / 1000
const sig = (label, direction, d, close = 100) => ({ label, direction, ts: ts(d), close, barsAgo: 3, lines: {} })
const sym = (symbol, scanState = {}) => ({ exchange: 'NSE', symbol, scanState })
const state = (signals, extra = {}) => ({ summary: { lastClose: 101.5, adx: { trend: 'increase' }, signals, ...extra } })
// columns: 0 symbol,1 bias,2 price,3 price,4 time; blocks of 6 from 5: 15m 5-10, 1h 11-16, 4h 17-22, 1d 23-28, 1w 29-34 (ADX, RSI, DI, MACD, TSI, Stoch)

test('NTPC: each indicator shows its OWN latest crossover date, E is the newest overall', () => {
  const ntpc = sym('NTPC', {
    '1hour': state([sig('RSI 14/14', 'bullish', '2026-11-09T10:15:00', 105), sig('MACD 12/26/9', 'bearish', '2026-11-06T10:15:00', 99)]),
  })
  const [r] = buildExportRows([ntpc])
  assert.equal(r.values.length, 35)
  assert.match(r.values[12], /^YES - Bullish · 09 Nov 26 11:15$/) // 1h RSI
  assert.match(r.values[14], /^YES - Bearish · 06 Nov 26 11:15$/) // 1h MACD, an older bar, still shown
  assert.equal(r.values[13], 'NO') // DI never crossed
  assert.equal(r.values[4], '09 Nov 26 11:15')
  assert.equal(r.values[3], 105)
  assert.equal(r.values[2], 101.5)
  assert.equal(r.values[11], 'Increase')
  assert.ok(r.colors[12] && r.colors[14])
  assert.notEqual(r.colors[12], r.colors[14])
})

test('every timeframe block is filled from its own summary; one row per symbol', () => {
  const s = sym('TCS', {
    '15minute': state([sig('TSI 25/13/13', 'bullish', '2026-11-10T14:45:00')]),
    '1day': state([sig('Stoch RSI 14/14/3/3', 'bearish', '2026-11-05T00:00:00')], { adx: { trend: 'decrease' } }),
  })
  const rows = buildExportRows([s, sym('INFY')])
  assert.equal(rows.length, 2)
  const v = rows[0].values
  assert.match(v[9], /^YES - Bullish/) // 15m TSI
  assert.equal(v[5], 'Increase')
  assert.equal(v[23], 'Decrease')
  assert.match(v[28], /^YES - Bearish · 05 Nov 26 15:30$/) // daily Stoch
  assert.equal(rows[1].values[4], '') // INFY: no crossover
  assert.equal(rows[1].values[12], 'NO')
})

test('legacy DI label maps to the DI column; newest of the two wins', () => {
  const s = sym('X', { '1hour': state([sig('ADX 14 (+DI/-DI)', 'bullish', '2026-11-01T10:15:00'), sig('DMI 14 (+DI/-DI)', 'bearish', '2026-11-03T10:15:00')]) })
  const [r] = buildExportRows([s])
  assert.match(r.values[13], /^YES - Bearish · 03 Nov/)
})

test('symbol without a scan summary uses the fallback card', () => {
  const card = { exchange: 'NSE', symbol: 'NEW', interval: '1day', candleTimestamp: ts('2026-11-04T00:00:00'), closePrice: 50, adx: { trend: 'flat' }, indicators: [{ label: 'RSI 14/14', direction: 'bullish' }] }
  const [r] = buildExportRows([sym('NEW')], new Map([['NSE_NEW_1day', card]]))
  assert.equal(r.values[23], 'Flat')
  assert.match(r.values[24], /^YES - Bullish · 04 Nov 26 15:30$/)
  assert.equal(r.values[3], 50)
})

test('filters: indicator / direction / adx / date range keep only matching crossovers and drop empty symbols', () => {
  const a = sym('A', { '1hour': state([sig('RSI 14/14', 'bullish', '2026-11-09T10:15:00'), sig('MACD 12/26/9', 'bearish', '2026-11-06T10:15:00')]) })
  const b = sym('B', { '1hour': state([sig('TSI 25/13/13', 'bullish', '2026-11-02T10:15:00')], { adx: { trend: 'flat' } }) })
  assert.equal(buildExportRows([a, b], new Map(), { indicator: ['MACD 12/26/9'] }).length, 1)
  assert.equal(buildExportRows([a, b], new Map(), { direction: 'bullish' }).length, 2)
  assert.equal(buildExportRows([a, b], new Map(), { adx: 'flat' }).length, 1)
  const ranged = buildExportRows([a, b], new Map(), { from: '2026-11-05T00:00:00+05:30', to: '2026-11-07T23:59:59+05:30' })
  assert.equal(ranged.length, 1)
  assert.match(ranged[0].values[14], /06 Nov/)
  assert.equal(ranged[0].values[12], 'NO') // 9 Nov RSI is outside the range
})

test('tie is Mixed; NaN close becomes blank', () => {
  const s = sym('T', { '1hour': state([sig('RSI 14/14', 'bullish', '2026-11-09T10:15:00', NaN), sig('MACD 12/26/9', 'bearish', '2026-11-08T10:15:00')], { lastClose: NaN }) })
  const [r] = buildExportRows([s])
  assert.equal(r.values[1], 'Mixed')
  assert.equal(r.values[2], '')
  assert.equal(r.values[3], '')
})

test('workbook header equals the template: merges and column titles', () => {
  const ws = renderWorkbook(buildExportRows([sym('TCS')]), {}).getWorksheet('Notification List')
  assert.deepEqual([...ws.model.merges].sort(), ['A1:C1', 'AD1:AI1', 'F1:K1', 'L1:Q1', 'R1:W1', 'X1:AC1'].sort())
  assert.equal(ws.getRow(2).getCell(5).value, 'Crossover Time')
  assert.equal(ws.getRow(2).getCell(35).value, 'Stoch RSI Crossover')
  assert.equal(ws.getRow(1).getCell(6).value, '15 Mins ')
})
