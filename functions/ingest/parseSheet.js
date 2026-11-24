/**
 * Excel / CSV -> "pages" of markdown tables (header row repeated every block), so
 * tables stay readable to the LLM and each block is a citable range
 * ("Sheet1 rows 2-41"). The sheet's own numbers are kept as written.
 */

import ExcelJS from 'exceljs'
import { parse as parseCsv } from 'csv-parse/sync'

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

export function parseCsvBuffer(buffer) {
  const text = buffer.toString('utf8').replace(/^﻿/, '')
  // relax_quotes: NSE's participant-wise OI file starts with a title like ""Participant wise ... 2026"",,,, which a strict parser rejects.
  const rows = parseCsv(text, { relax_column_count: true, relax_quotes: true, skip_empty_lines: true, bom: true })
  const pages = rowsToPages(rows, 'CSV', 1)
  return { pageCount: pages.length, pages, needsOcr: false }
}
