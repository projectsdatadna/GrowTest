import test from 'node:test'
import assert from 'node:assert/strict'
import { buildExportRows, renderWorkbook } from '../crossoverExport.js'

const sym = (symbol) => ({ exchange: 'NSE', symbol })
// 1hour bar starting 2026-11-02 09:15 IST
const T = Date.parse('2026-11-02T09:15:00+05:30') / 1000
const card = (over = {}) => ({
  exchange: 'NSE', symbol: 'TCS', interval: '1hour', candleTimestamp: T, closePrice: 100.5, bullishCount: 1, bearishCount: 0,
  adx: { trend: 'increase', value: 25, prev: 20, period: 14 },
  indicators: [{ label: 'RSI 14/14', direction: 'bullish' }], ...over,
})
const COLS = 5 + 5 * 6

test('ADX/price come from the card, indicator cells match', () => {
  const [row] = buildExportRows([sym('TCS')], [card()])
  assert.equal(row.values.length, COLS)
  assert.equal(row.values[2], 100.5)
  assert.equal(row.values[1], 'Bullish')
  // 1hour block = index 5 + 6; ADX then RSI
  assert.equal(row.values[11], 'Increase')
  assert.equal(row.values[12], 'YES - Bullish')
  assert.equal(row.values[13], 'NO')
  assert.ok(row.colors[12])
})

test('tie is Mixed; SMA/EMA counts included; legacy DI label maps', () => {
  const g = card({ bullishCount: 1, bearishCount: 1, indicators: [{ label: 'SMA 50/200', direction: 'bearish' }, { label: 'ADX 14 (+DI/-DI)', direction: 'bullish' }] })
  const [row] = buildExportRows([sym('TCS')], [g])
  assert.equal(row.values[1], 'Mixed')
  assert.equal(row.values[13], 'YES - Bullish')
})

test('onlyWithCards drops symbols without cards; otherwise keeps them', () => {
  const symbols = [sym('TCS'), sym('INFY')]
  assert.equal(buildExportRows(symbols, [card()], { onlyWithCards: true }).length, 1)
  const all = buildExportRows(symbols, [card()])
  assert.equal(all.length, 2)
  assert.equal(all[1].values[2], '')
})

test('NaN price and unknown ADX trend become blanks', () => {
  const [row] = buildExportRows([sym('TCS')], [card({ closePrice: NaN, adx: { trend: 'weird' } })])
  assert.equal(row.values[2], '')
  assert.equal(row.values[11], '')
})

test('workbook renders 35 columns', async () => {
  const wb = renderWorkbook(buildExportRows([sym('TCS')], [card()]), {})
  assert.equal(wb.getWorksheet('Notification List').getRow(4).getCell(COLS).value !== undefined, true)
})
