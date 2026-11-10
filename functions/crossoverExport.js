/**
 * Excel export of the Notifications page, in the exact layout of the
 * "Notification List" template (Sheet2):
 *
 *   row 1: A1:C1 blank (merged), then one merged 6-column block per timeframe
 *          (15 Mins / 1 Hour / 4 Hour / Daily / Weekly)
 *   row 2: SYMBOL | Bullish/ Bearish | Price | Price | Crossover Time, then per
 *          timeframe ADX Trend | RSI | DI | MACD | TSI | Stoch RSI Crossover
 *   row 3: the template's hint row (Increase/ Decrease/ Flat, YES/NO)
 *   row 4+: one row per active scanner symbol - indices first, then the
 *          uploaded list order (sortOrder) - even when it has no crossovers
 *
 * Values: B = majority direction of the symbol's crossovers in the window,
 * C = latest close, D = close at the latest crossover, E = latest crossover
 * time (bar end, IST). Per timeframe: ADX trend from the latest scan, and YES
 * when that indicator crossed in the window (green = bullish, red = bearish).
 * SMA/EMA crossovers have no template column and are left out.
 */

import ExcelJS from 'exceljs'
import { TIMEFRAME_ORDER, candleEnd } from './crossoverTimeframes.js'
import { latestCrossoverGroup, listActiveScannerSymbols, listCrossoversForExport, listGroupAdxForExport } from './crossoverScannerFirestoreClient.js'

const TIMEFRAME_HEADERS = { '15minute': '15 Mins ', '1hour': '1 Hour', '4hour': '4 Hour', '1day': 'Daily', '1week': 'Weekly' }

// Template columns per timeframe, in order. `labels` = the scanner's
// indicatorLabel values that fill the column (incl. the pre-rename DMI label).
const INDICATOR_COLUMNS = [
  { header: 'RSI Crossover', hint: 'YES/No', labels: ['RSI 14/14'] },
  { header: 'DI Crossover', hint: 'YES/NO', labels: ['DMI 14 (+DI/-DI)', 'ADX 14 (+DI/-DI)'] },
  { header: 'MACD Crossover', hint: 'YES/NO', labels: ['MACD 12/26/9'] },
  { header: 'TSI Crossover', hint: 'YES/NO', labels: ['TSI 25/13/13'] },
  { header: 'Stoch RSI Crossover', hint: 'YES/NO', labels: ['Stoch RSI 14/14/3/3'] },
]
const COLUMN_BY_LABEL = new Map(INDICATOR_COLUMNS.flatMap((col, i) => col.labels.map((label) => [label, i])))
const BLOCK_WIDTH = 1 + INDICATOR_COLUMNS.length // ADX Trend + indicators
const FIRST_BLOCK_COL = 6 // F
const ADX_TEXT = { increase: 'Increase', decrease: 'Decrease', flat: 'Flat' }

const GREEN = 'FF1E8E3E'
const RED = 'FFD93025'
const BASE_FONT = { name: 'Arial', size: 10 }
const SYMBOL_FONT = { name: 'Inter', size: 10, color: { argb: 'FF424242' } }

const istFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata',
  day: '2-digit',
  month: 'short',
  year: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})
const formatIst = (epochSeconds) => istFormatter.format(new Date(epochSeconds * 1000)).replace(',', '')

const istDay = (date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(date)
const istDayRange = (day) => ({ from: new Date(`${day}T00:00:00+05:30`).toISOString(), to: new Date(`${day}T23:59:59+05:30`).toISOString() })

// No date filter on the page: the most recent IST day that has crossovers (the
// page lists the newest cards, so "today" would export an empty sheet whenever
// no scan has run today). Falls back to today when nothing is stored yet.
export async function defaultExportRange(now = new Date()) {
  const latest = await latestCrossoverGroup()
  const end = latest ? candleEnd(latest.interval, latest.candleTimestamp) ?? latest.candleTimestamp : null
  const day = istDay(end ? new Date(Math.min(end * 1000, now.getTime())) : now)
  return { ...istDayRange(day), day }
}

// {from, to} the page asked for, or the default day. `day` is set only for the default.
export async function resolveExportRange({ from, to } = {}) {
  return from || to ? { from, to } : defaultExportRange()
}

/**
 * Pure: symbols (ordered) + crossover notifications -> row value arrays.
 * Each row: {values: [...35 cells], colors: {colIndex: argb}}.
 */
export function buildExportRows(symbols, crossovers, groupAdx = new Map()) {
  const bySymbol = new Map()
  for (const n of crossovers) {
    if (!COLUMN_BY_LABEL.has(n.indicatorLabel)) continue
    const key = `${n.exchange}_${n.symbol}`
    if (!bySymbol.has(key)) bySymbol.set(key, [])
    bySymbol.get(key).push({ ...n, barEnd: candleEnd(n.interval, n.candleTimestamp) ?? n.candleTimestamp })
  }

  return symbols.map((entry) => {
    const events = (bySymbol.get(`${entry.exchange}_${entry.symbol}`) || []).sort((a, b) => a.barEnd - b.barEnd)
    const latest = events.at(-1)
    const bullish = events.filter((e) => e.direction === 'bullish').length
    const bearish = events.length - bullish
    const bias = events.length === 0 ? '' : bullish > bearish ? 'Bullish' : bearish > bullish ? 'Bearish' : 'Neutral'
    const groupFor = (interval) => groupAdx.get(`${entry.exchange}_${entry.symbol}_${interval}`)
    const lastClose =
      TIMEFRAME_ORDER.map((i) => entry.scanState?.[i]?.summary?.lastClose).find((v) => v != null) ?? TIMEFRAME_ORDER.map((i) => groupFor(i)?.closePrice).find((v) => v != null) ?? ''

    const values = [entry.symbol, bias, lastClose, latest?.closePrice ?? '', latest ? formatIst(latest.barEnd) : '']
    const colors = {}
    for (const interval of TIMEFRAME_ORDER) {
      const adx = entry.scanState?.[interval]?.summary?.adx ?? groupFor(interval)?.adx
      values.push(adx ? ADX_TEXT[adx.trend] : '')
      INDICATOR_COLUMNS.forEach((col, i) => {
        const hits = events.filter((e) => e.interval === interval && COLUMN_BY_LABEL.get(e.indicatorLabel) === i)
        const colIndex = values.length // 0-based, before push
        values.push(hits.length ? 'YES' : 'NO')
        if (hits.length) colors[colIndex] = hits.at(-1).direction === 'bullish' ? GREEN : RED
      })
    }
    return { values, colors }
  })
}

function writeHeader(sheet) {
  sheet.mergeCells('A1:C1')
  const row1 = sheet.getRow(1)
  const row2 = sheet.getRow(2)
  const row3 = sheet.getRow(3)
  ;['SYMBOL', 'Bullish/ Bearish', 'Price', 'Price', 'Crossover Time'].forEach((text, i) => {
    row2.getCell(i + 1).value = text
  })
  TIMEFRAME_ORDER.forEach((interval, block) => {
    const start = FIRST_BLOCK_COL + block * BLOCK_WIDTH
    sheet.mergeCells(1, start, 1, start + BLOCK_WIDTH - 1)
    row1.getCell(start).value = TIMEFRAME_HEADERS[interval]
    row1.getCell(start).alignment = { horizontal: 'center' }
    row2.getCell(start).value = 'ADX Trend'
    row3.getCell(start).value = 'Increase/ Decrease/ Flat'
    INDICATOR_COLUMNS.forEach((col, i) => {
      row2.getCell(start + 1 + i).value = col.header
      row3.getCell(start + 1 + i).value = col.hint
    })
  })
  for (const row of [row1, row2, row3]) row.eachCell((cell) => (cell.font = cell.font?.name ? cell.font : BASE_FONT))
  for (let c = 1; c <= 3; c++) row2.getCell(c).font = SYMBOL_FONT
}

export async function buildNotificationWorkbook({ from, to } = {}) {
  const range = await resolveExportRange({ from, to })
  const [symbols, crossovers, groupAdx] = await Promise.all([listActiveScannerSymbols(), listCrossoversForExport(range), listGroupAdxForExport(range)])
  return { workbook: renderWorkbook(buildExportRows(symbols, crossovers, groupAdx), range), range }
}

export function renderWorkbook(rows, range = {}) {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'GrowTest Crossover Scanner'
  workbook.title = `Notification List ${range.from || ''} - ${range.to || ''}`.trim()
  const sheet = workbook.addWorksheet('Notification List', {
    properties: { defaultColWidth: 12.63, defaultRowHeight: 15.75 },
    views: [{ state: 'frozen', xSplit: 1, ySplit: 3 }],
  })
  // Template widths: E-F 19.13, K-AI 16.5.
  for (const c of [5, 6]) sheet.getColumn(c).width = 19.13
  for (let c = 11; c <= FIRST_BLOCK_COL + TIMEFRAME_ORDER.length * BLOCK_WIDTH - 1; c++) sheet.getColumn(c).width = 16.5

  writeHeader(sheet)
  rows.forEach(({ values, colors }, r) => {
    const row = sheet.getRow(4 + r)
    values.forEach((value, c) => {
      const cell = row.getCell(c + 1)
      cell.value = value
      cell.font = c === 0 ? SYMBOL_FONT : colors[c] ? { ...BASE_FONT, bold: true, color: { argb: colors[c] } } : BASE_FONT
    })
  })
  return workbook
}
