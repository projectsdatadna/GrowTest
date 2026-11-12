/**
 * Reads the NRML margin sheet (Sheet1 of "Notification List (8).xlsx"):
 * column A = SYMBOL, column B = NRML Margin. Pure apart from the file read, so
 * the parsing is tested offline.
 */

import ExcelJS from 'exceljs'

// Cell value -> number, or null for blank / not a usable margin. Accepts numbers
// and strings like "71,842" or "₹ 71842".
export function parseMarginCell(value) {
  if (value == null || value === '') return null
  const raw = typeof value === 'object' && 'result' in value ? value.result : value
  if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 ? raw : null
  const cleaned = String(raw).replace(/[₹,\s]/g, '')
  if (cleaned === '') return null
  const n = Number(cleaned)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/**
 * Rows ({symbol, text, margin}) from a worksheet-like `getRow(i).getCell(j).value`
 * reader. The header row ("SYMBOL") is skipped; a symbol listed twice keeps the
 * last non-blank margin. Result order = sheet order.
 */
export function readMarginRows(sheet) {
  const bySymbol = new Map()
  sheet.eachRow((row) => {
    const symbol = String(row.getCell(1).text ?? row.getCell(1).value ?? '').trim().toUpperCase()
    if (!symbol || symbol === 'SYMBOL') return
    const margin = parseMarginCell(row.getCell(2).value)
    const previous = bySymbol.get(symbol)
    bySymbol.set(symbol, { symbol, margin: margin ?? previous?.margin ?? null })
  })
  return [...bySymbol.values()]
}

export async function readMarginSheet(path) {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(path)
  return readMarginRows(workbook.worksheets[0])
}
