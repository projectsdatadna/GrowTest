#!/usr/bin/env node
/**
 * Offline check of the Excel export against the template workbook:
 *   - Sheet1 parses to the expected symbol order (first occurrence wins)
 *   - rows 1-3 + merged ranges of the generated sheet equal template Sheet2
 *   - data rows: indices first, list order, YES/NO + ADX mapping
 *
 *   node scripts/verify-export.mjs ["Notification List (2).xlsx"] [--url http://localhost:5055]
 * With --url, the live /crossover-scanner/export.xlsx is downloaded and its
 * header checked too (needs the server running).
 */
import ExcelJS from '../functions/node_modules/exceljs/excel.js'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { buildExportRows, renderWorkbook } from '../functions/crossoverExport.js'
import { readSheet1Symbols } from '../functions/scripts/importSymbolOrder.mjs'
import { compareSymbolOrder } from '../functions/crossoverScannerFirestoreClient.js'

const args = process.argv.slice(2)
const urlIndex = args.indexOf('--url')
const url = urlIndex >= 0 ? args[urlIndex + 1] : null
const templatePath = resolve(args.find((a, i) => !a.startsWith('--') && i !== urlIndex + 1) || 'Notification List (2).xlsx')

const template = new ExcelJS.Workbook()
await template.xlsx.readFile(templatePath)
const tSheet = template.worksheets[1]

function compareHeader(sheet, label) {
  for (let r = 1; r <= 3; r++) {
    for (let c = 1; c <= 35; c++) {
      const want = tSheet.getRow(r).getCell(c)
      const got = sheet.getRow(r).getCell(c)
      if (want.isMerged && want.master.address !== want.address) continue
      assert.equal(String(got.value ?? ''), String(want.value ?? ''), `${label}: ${got.address}`)
    }
  }
  const merges = (s) => Object.keys(s._merges).sort()
  assert.deepEqual(merges(sheet), merges(tSheet), `${label}: merged ranges`)
  console.log(`✓ ${label}: rows 1-3 and merges match template Sheet2`)
}

// 1. Sheet1 order
const order = await readSheet1Symbols(templatePath)
assert.equal(order[0], 'NIFTY')
assert.equal(order.filter((s) => s === 'NIFTY').length, 1)
assert.equal(order.at(-1), 'POLYCAB')
console.log(`✓ Sheet1: ${order.length} unique symbols, NIFTY once, first=${order[0]} last=${order.at(-1)}`)

// 2. Rows from fake data in list order
const symbols = order.map((symbol, i) => ({ symbol, exchange: 'NSE', sortOrder: i })).sort(compareSymbolOrder)
const firstStock = symbols.findIndex((s) => !/^(NIFTY|BANKNIFTY|FINNIFTY|MIDCPNIFTY)/.test(s.symbol))
assert.ok(symbols.slice(0, firstStock).every((s) => /NIFTY/.test(s.symbol)), 'indices first')
assert.deepEqual(symbols.slice(firstStock).map((s) => s.symbol), order.filter((s) => !/^(NIFTY|BANKNIFTY|FINNIFTY|MIDCPNIFTY)/.test(s)), 'stocks keep Sheet1 order')
console.log(`✓ order: ${firstStock} indices first (${symbols.slice(0, firstStock).map((s) => s.symbol).join(', ')}), then Sheet1 order`)

const hdfc = symbols.find((s) => s.symbol === 'HDFCBANK')
hdfc.scanState = { '15minute': { summary: { lastClose: 1650.5, adx: { trend: 'increase', value: 27.4, prev: 26.8 } } }, '1hour': { summary: { adx: { trend: 'flat' } } } }
const crossovers = [
  { symbol: 'HDFCBANK', exchange: 'NSE', interval: '15minute', indicatorLabel: 'MACD 12/26/9', direction: 'bullish', candleTimestamp: 1762757100, closePrice: 1648 },
  { symbol: 'HDFCBANK', exchange: 'NSE', interval: '15minute', indicatorLabel: 'ADX 14 (+DI/-DI)', direction: 'bullish', candleTimestamp: 1762757100, closePrice: 1648 },
  { symbol: 'HDFCBANK', exchange: 'NSE', interval: '1hour', indicatorLabel: 'RSI 14/14', direction: 'bearish', candleTimestamp: 1762753500, closePrice: 1645 },
  { symbol: 'HDFCBANK', exchange: 'NSE', interval: '1hour', indicatorLabel: 'SMA 50/200', direction: 'bearish', candleTimestamp: 1762753500, closePrice: 1645 },
]
const rows = buildExportRows(symbols, crossovers)
const row = rows[symbols.indexOf(hdfc)].values
assert.equal(row.length, 35)
assert.deepEqual(row.slice(0, 3), ['HDFCBANK', 'Bullish', 1650.5])
assert.equal(row[3], 1648)
assert.deepEqual(row.slice(5, 11), ['Increase', 'NO', 'YES', 'YES', 'NO', 'NO'], '15m block: ADX, RSI, DI(legacy label), MACD, TSI, StochRSI')
assert.deepEqual(row.slice(11, 17), ['Flat', 'YES', 'NO', 'NO', 'NO', 'NO'], '1h block (SMA ignored)')
assert.ok(rows.every((r) => r.values.length === 35))
console.log(`✓ HDFCBANK row: ${row.slice(0, 17).join(' | ')}`)

// 3. Rendered workbook vs template
const wb = renderWorkbook(rows)
const roundTrip = new ExcelJS.Workbook()
await roundTrip.xlsx.load(await wb.xlsx.writeBuffer())
compareHeader(roundTrip.worksheets[0], 'generated workbook')
assert.equal(roundTrip.worksheets[0].getRow(4).getCell(1).value, symbols[0].symbol)
assert.equal(roundTrip.worksheets[0].rowCount, 3 + symbols.length)

if (url) {
  const res = await fetch(`${url.replace(/\/$/, '')}/crossover-scanner/export.xlsx`)
  assert.equal(res.status, 200, `export HTTP ${res.status}`)
  const live = new ExcelJS.Workbook()
  await live.xlsx.load(Buffer.from(await res.arrayBuffer()))
  compareHeader(live.worksheets[0], 'live export')
  console.log(`✓ live export: ${live.worksheets[0].rowCount - 3} symbol rows`)
}
console.log('All export checks passed.')
