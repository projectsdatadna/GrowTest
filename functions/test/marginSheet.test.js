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
