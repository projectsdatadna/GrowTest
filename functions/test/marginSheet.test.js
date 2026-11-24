import test from 'node:test'
import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'
import { parseMarginCell, readMarginRows } from '../marginSheet.js'

test('margin cells: numbers, formatted strings, formulas; blanks and junk are null', () => {
  assert.equal(parseMarginCell(71842), 71842)
  assert.equal(parseMarginCell('71,842'), 71842)
  assert.equal(parseMarginCell('₹ 61360'), 61360)
  assert.equal(parseMarginCell({ formula: 'A1*2', result: 500 }), 500)
  assert.equal(parseMarginCell(''), null)
  assert.equal(parseMarginCell(null), null)
  assert.equal(parseMarginCell('n/a'), null)
  assert.equal(parseMarginCell(-5), null)
})

test('sheet rows: header skipped, symbols upper-cased, blank margin kept as null, duplicates merged', () => {
  const sheet = new ExcelJS.Workbook().addWorksheet('Sheet1')
  sheet.addRows([['SYMBOL', 'NRML Margin'], ['nifty'], ['VEDL', 61360], ['PIIND', '71,842'], ['VEDL', null], [null, 5]])
  assert.deepEqual(readMarginRows(sheet), [
    { symbol: 'NIFTY', margin: null },
    { symbol: 'VEDL', margin: 61360 },
    { symbol: 'PIIND', margin: 71842 },
  ])
})

import { readSymbolSheetRows, readSymbolSheetFromWorkbook } from '../marginSheet.js'
import { planSymbolSheetImport } from '../symbolSheetImport.js'

test('symbol sheet: columns found by header name in any order; blanks null; duplicates merged', () => {
  const sheet = new ExcelJS.Workbook().addWorksheet('Sheet2')
  sheet.addRows([
    ['Lot Size', 'SYMBOL', 'Price', 'Margin'],
    [1150, 'vedl', 237.85, 62266],
    [175, 'PIIND', '1,591.70', '66,265'],
    [null, 'NIFTY', null, null],
    [1200, 'VEDL', null, null],
    [0, 'BAD', -1, 'n/a'],
  ])
  assert.deepEqual(readSymbolSheetRows(sheet), [
    { symbol: 'VEDL', margin: 62266, price: 237.85, lotSize: 1200 },
    { symbol: 'PIIND', margin: 66265, price: 1591.7, lotSize: 175 },
    { symbol: 'NIFTY', margin: null, price: null, lotSize: null },
    { symbol: 'BAD', margin: null, price: null, lotSize: null },
  ])
})

test('symbol sheet: workbook lookup skips sheets without the headers (Sheet1 formulas vs Sheet2 data)', () => {
  const workbook = new ExcelJS.Workbook()
  workbook.addWorksheet('Sheet1').addRows([['Stoploss', 7500], ['Target', 17000], [null, 'Lot Size', 'Stoploss', 'Stoploss %']])
  workbook.addWorksheet('Sheet2').addRows([['SYMBOL', 'Margin', 'Price', 'Lot Size'], ['VEDL', 62266, 237.85, 1150]])
  const found = readSymbolSheetFromWorkbook(workbook)
  assert.equal(found.sheetName, 'Sheet2')
  assert.deepEqual(found.rows, [{ symbol: 'VEDL', margin: 62266, price: 237.85, lotSize: 1150 }])
  assert.equal(readSymbolSheetFromWorkbook(new ExcelJS.Workbook()), null)
})

test('import plan: lot size + sheet price always refresh, margin only when unset or --overwrite, unmatched reported', () => {
  const active = [
    { symbol: 'VEDL', exchange: 'NSE', nrmlMargin: 50000, lotSize: 1000 },
    { symbol: 'PIIND', exchange: 'NSE', nrmlMargin: null },
    { symbol: 'ITC', exchange: 'NSE', nrmlMargin: 92172, lotSize: 1725, sheetPrice: 300.95 },
  ]
  const rows = [
    { symbol: 'VEDL', margin: 62266, price: 237.85, lotSize: 1150 },
    { symbol: 'PIIND', margin: 66265, price: 1591.7, lotSize: 175 },
    { symbol: 'ITC', margin: 92172, price: 300.95, lotSize: 1725 },
    { symbol: 'GONE', margin: 1, price: 1, lotSize: 1 },
  ]
  const keep = planSymbolSheetImport(rows, active)
  assert.deepEqual(keep.unmatched, ['GONE'])
  assert.deepEqual(keep.keptMargin, ['VEDL'])
  assert.deepEqual(keep.updates.find((u) => u.symbol === 'VEDL').fields, { lotSize: 1150, sheetPrice: 237.85 })
  assert.deepEqual(keep.updates.find((u) => u.symbol === 'PIIND').fields, { nrmlMargin: 66265, lotSize: 175, sheetPrice: 1591.7 })
  assert.equal(keep.updates.find((u) => u.symbol === 'ITC').changed, false)
  assert.deepEqual(keep.scannerWithoutLotSize, { stocks: [], indices: [] })
  const over = planSymbolSheetImport(rows, active, { overwrite: true })
  assert.equal(over.updates.find((u) => u.symbol === 'VEDL').fields.nrmlMargin, 62266)
})

test('import plan: lists the scanner symbols that still have no lot size afterwards, stocks and indices apart', () => {
  const active = [
    { symbol: 'ZZSTOCK1', exchange: 'NSE' },
    { symbol: 'ZZSTOCK2', exchange: 'NSE' },
    { symbol: 'ZZSTOCK3', exchange: 'NSE', lotSize: 1725 },
    { symbol: 'ZZSTOCK4', exchange: 'NSE', lotSizeOverride: 50 },
    { symbol: 'IEX', exchange: 'NSE' },
    { symbol: 'NIFTY', exchange: 'NSE', isIndex: true },
    { symbol: 'NIFTYIT', exchange: 'NSE', isIndex: true },
    { symbol: 'ZZINDEX', exchange: 'NSE', isIndex: true },
  ]
  const plan = planSymbolSheetImport([{ symbol: 'ZZSTOCK1', margin: null, price: 200, lotSize: 1150 }, { symbol: 'ZZINDEX', margin: null, price: null, lotSize: 65 }], active)
  assert.deepEqual(plan.scannerWithoutLotSize, { stocks: ['ZZSTOCK2'], indices: ['NIFTYIT'] }, 'set by this sheet, already imported, typed on a card, or built into the app (IEX, NIFTY) all count as covered')
})
