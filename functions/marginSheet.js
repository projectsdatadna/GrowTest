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

// ---------- symbol sheet: SYMBOL | Margin | Price | Lot Size ----------
// Sheet2 of "Stp & Target Sample.xlsx". Columns are found by header name (not
// position) and the sheet by its headers, so the order of columns or sheets
// in a refreshed upload does not matter.

const HEADER_ALIASES = {
  symbol: ['symbol'],
  margin: ['margin', 'nrml margin'],
  price: ['price', 'ltp'],
  lotSize: ['lot size', 'lotsize', 'lot'],
}

function headerText(value) {
  const raw = value && typeof value === 'object' ? (value.result ?? value.text ?? (Array.isArray(value.richText) ? value.richText.map((r) => r.text).join('') : '')) : value
  return String(raw ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

// {symbol, margin, price, lotSize} -> 1-based column numbers, for the first of the
// first 5 rows that has a SYMBOL header and at least one data column; else null.
export function findSymbolSheetColumns(sheet) {
  for (let r = 1; r <= Math.min(5, sheet.rowCount || 5); r += 1) {
    const row = sheet.getRow(r)
    const columns = {}
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      const text = headerText(cell.value)
      for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
        if (columns[key] === undefined && aliases.includes(text)) columns[key] = col
      }
    })
    if (columns.symbol && (columns.margin || columns.price || columns.lotSize)) return { headerRow: r, columns }
  }
  return null
}

const positiveOrNull = (value) => {
  const n = parseMarginCell(value)
  return n != null && n > 0 ? n : null
}

/**
 * Rows ({symbol, margin, price, lotSize}) of a sheet-like object, or null when the
 * sheet has no recognisable header. Blank / non-numeric cells are null; a symbol
 * listed twice keeps the last non-blank value of each field.
 */
export function readSymbolSheetRows(sheet) {
  const found = findSymbolSheetColumns(sheet)
  if (!found) return null
  const { headerRow, columns } = found
  const bySymbol = new Map()
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber <= headerRow) return
    const symbol = String(row.getCell(columns.symbol).text ?? row.getCell(columns.symbol).value ?? '').trim().toUpperCase()
    if (!symbol) return
    const next = {
      margin: columns.margin ? parseMarginCell(row.getCell(columns.margin).value) : null,
      price: columns.price ? positiveOrNull(row.getCell(columns.price).value) : null,
      lotSize: columns.lotSize ? positiveOrNull(row.getCell(columns.lotSize).value) : null,
    }
    const previous = bySymbol.get(symbol)
    bySymbol.set(symbol, {
      symbol,
      margin: next.margin ?? previous?.margin ?? null,
      price: next.price ?? previous?.price ?? null,
      lotSize: next.lotSize ?? previous?.lotSize ?? null,
    })
  })
  return [...bySymbol.values()]
}

// First worksheet of the workbook that has the symbol-sheet headers.
export function readSymbolSheetFromWorkbook(workbook) {
  for (const sheet of workbook.worksheets) {
    const rows = readSymbolSheetRows(sheet)
    if (rows) return { sheetName: sheet.name, rows }
  }
  return null
}

export async function readSymbolSheetFromBuffer(buffer) {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer)
  return readSymbolSheetFromWorkbook(workbook)
}

export async function readSymbolSheetFile(path) {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(path)
  return readSymbolSheetFromWorkbook(workbook)
}
