/**
 * Excel / CSV -> "pages" of markdown tables (header row repeated every block), so
 * tables stay readable to the LLM and each block is a citable range
 * ("Sheet1 rows 2-41"). The sheet's own numbers are kept as written.
 */

import ExcelJS from 'exceljs'
import * as SheetJS from 'xlsx'
import { parse as parseCsv } from 'csv-parse/sync'
import { decodeText } from './text.js'

const ROWS_PER_PAGE = 40
const MAX_COLUMNS = 60

const cellText = (value) => {
  if (value == null) return ''
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'object') {
    if ('result' in value) return cellText(value.result)
    if (Array.isArray(value.richText)) return value.richText.map((r) => r.text).join('')
    if ('text' in value) return String(value.text)
    return ''
  }
  return String(value).replace(/\s+/g, ' ').trim()
}
const escapeCell = (text) => text.replace(/\|/g, '\\|')

// rows: array of string arrays (first non-empty row = header).
export function rowsToPages(rows, sheetName, startPage) {
  const cleaned = rows.map((row) => row.slice(0, MAX_COLUMNS).map(cellText)).filter((row) => row.some(Boolean))
  if (cleaned.length === 0) return []
  const [headerRow, ...body] = cleaned
  const width = Math.max(...cleaned.map((r) => r.length))
  const pad = (row) => Array.from({ length: width }, (_, i) => escapeCell(row[i] ?? ''))
  const header = `| ${pad(headerRow).join(' | ')} |\n| ${pad(headerRow).map(() => '---').join(' | ')} |`
  const pages = []
  for (let i = 0; i < body.length || (i === 0 && body.length === 0); i += ROWS_PER_PAGE) {
    const slice = body.slice(i, i + ROWS_PER_PAGE)
    pages.push({
      page: startPage + pages.length,
      label: slice.length ? `${sheetName} rows ${i + 2}-${i + 1 + slice.length}` : sheetName,
      text: `${header}\n${slice.map((r) => `| ${pad(r).join(' | ')} |`).join('\n')}`.trim(),
    })
  }
  return pages
}

export async function parseXlsx(buffer) {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer)
  const pages = []
  for (const sheet of workbook.worksheets) {
    const rows = []
    sheet.eachRow({ includeEmpty: false }, (row) => rows.push(Array.from({ length: row.cellCount }, (_, i) => row.getCell(i + 1).value)))
    pages.push(...rowsToPages(rows, sheet.name, pages.length + 1))
  }
  return { pageCount: pages.length, pages, needsOcr: false }
}

// SheetJS reads what ExcelJS cannot: the old binary .xls / .xlt, .xlsb and OpenDocument .ods. Cells come as the text
// Excel shows (raw: false), so a number keeps its format and a date reads as a date.
export function parseWithSheetJs(buffer) {
  const workbook = SheetJS.read(buffer, { type: 'buffer', cellDates: true })
  const pages = []
  for (const name of workbook.SheetNames) {
    const rows = SheetJS.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: false, defval: '', blankrows: false })
    pages.push(...rowsToPages(rows, name, pages.length + 1))
  }
  return { pageCount: pages.length, pages, needsOcr: false }
}

const OOXML = new Set(['xlsx', 'xlsm', 'xltx', 'xltm'])

/** Any Excel-family workbook (.xlsx .xlsm .xltx .xltm .xls .xlt .xlsb .ods) -> { pages }. ExcelJS first for the XML formats, SheetJS for the rest and as the fallback. */
export async function parseWorkbook(buffer, fileName = '') {
  const extension = (/\.([A-Za-z0-9]+)$/.exec(fileName)?.[1] || '').toLowerCase()
  if (OOXML.has(extension)) {
    try {
      const parsed = await parseXlsx(buffer)
      if (parsed.pages.length) return parsed
    } catch {
      // fall through to SheetJS: a template or macro workbook ExcelJS does not accept
    }
  }
  return parseWithSheetJs(buffer)
}

const cellOfJson = (value) => (value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value))
const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// An array of objects -> a table (header = every key, in first-seen order).
function recordsToRows(records) {
  const keys = []
  for (const r of records) for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k)
  return [keys, ...records.map((r) => keys.map((k) => cellOfJson(r[k])))]
}

/**
 * JSON text -> { tables: pages of markdown tables } when it is data shaped like a table (an array of objects, or an
 * object holding such arrays), otherwise { text } = the pretty-printed JSON. Throws when it is not valid JSON.
 */
export function parseJsonText(raw) {
  const data = JSON.parse(raw.replace(/^﻿/, ''))
  const tables = []
  if (Array.isArray(data) && data.length > 0 && data.every(isRecord)) tables.push(['JSON', data])
  else if (isRecord(data)) for (const [key, value] of Object.entries(data)) if (Array.isArray(value) && value.length > 0 && value.every(isRecord)) tables.push([key, value])
  const rest = isRecord(data) ? Object.fromEntries(Object.entries(data).filter(([, v]) => !(Array.isArray(v) && v.length > 0 && v.every(isRecord)))) : null
  if (!tables.length) return { text: JSON.stringify(data, null, 2) ?? String(data), pages: [] }
  const pages = []
  for (const [name, records] of tables) pages.push(...rowsToPages(recordsToRows(records), name, pages.length + 1))
  const other = rest && Object.keys(rest).length ? JSON.stringify(rest, null, 2) : ''
  return { text: other, pages }
}

export function parseJsonBuffer(buffer) {
  const parsed = parseJsonText(decodeText(buffer))
  return { pageCount: parsed.pages.length, pages: parsed.pages, text: parsed.text, needsOcr: false }
}

export function parseCsvBuffer(buffer) {
  const text = decodeText(buffer)
  // relax_quotes: NSE's participant-wise OI file starts with a title like ""Participant wise ... 2026"",,,, which a strict parser rejects.
  const rows = parseCsv(text, { relax_column_count: true, relax_quotes: true, skip_empty_lines: true, bom: true })
  const pages = rowsToPages(rows, 'CSV', 1)
  return { pageCount: pages.length, pages, needsOcr: false }
}
