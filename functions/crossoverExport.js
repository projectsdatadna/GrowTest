/**
 * Excel export of the Notifications tab in the "Notification List" template
 * (Sheet2 of the template workbook):
 *
 *   row 1: A1:C1 blank (merged), then one merged 6-column block per timeframe
 *          (15 Mins / 1 Hour / 4 Hour / Daily / Weekly)
 *   row 2: SYMBOL | Bullish/ Bearish | Price | Price | Crossover Time | NRML Margin, then per
 *          timeframe ADX Trend | RSI | DI | MACD | TSI | Stoch RSI Crossover
 *   row 3: hint row
 *   row 4+: ONE row per active scanner symbol (indices first, then list order)
 *
 * One row per symbol. In every timeframe block each indicator shows ITS OWN latest
 * crossover - direction plus the date/time it happened (e.g. "YES - Bullish · 06 Nov
 * 26 15:15") - taken from the scanner's per-timeframe summary (the latest crossover of
 * every indicator, whether or not it alerted); NO only if it never crossed. B = bias of
 * those latest crossovers, C = latest close, D = close at the newest crossover,
 * E = date and time of the symbol's newest crossover (bar end, IST).
 */

import ExcelJS from 'exceljs'
import { TIMEFRAME_ORDER, candleEnd } from './crossoverTimeframes.js'
import { listActiveScannerSymbols, listLatestGroupsForPairs } from './crossoverScannerFirestoreClient.js'

const TIMEFRAME_HEADERS = { '15minute': '15 Mins ', '1hour': '1 Hour', '4hour': '4 Hour', '1day': 'Daily', '1week': 'Weekly' }
const HINT = 'YES - Bullish · date/ YES - Bearish · date/ NO'

// Template columns per timeframe, in order. `labels` = the scanner's
// indicatorLabel values that fill the column (incl. the pre-rename DMI label).
const INDICATOR_COLUMNS = [
  { header: 'RSI Crossover', labels: ['RSI 14/14'] },
  { header: 'DI Crossover', labels: ['DMI 14 (+DI/-DI)', 'ADX 14 (+DI/-DI)'] },
  { header: 'MACD Crossover', labels: ['MACD 12/26/9'] },
  { header: 'TSI Crossover', labels: ['TSI 25/13/13'] },
  { header: 'Stoch RSI Crossover', labels: ['Stoch RSI 14/14/3/3'] },
]
const COLUMN_BY_LABEL = new Map(INDICATOR_COLUMNS.flatMap((col, i) => col.labels.map((label) => [label, i])))
const BLOCK_WIDTH = 1 + INDICATOR_COLUMNS.length // ADX Trend + indicators
const FIRST_BLOCK_COL = 7 // G (after the NRML Margin column, F)
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

const finiteOrBlank = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : '')

const barEndOf = (interval, ts) => candleEnd(interval, ts) ?? ts
const toSeconds = (iso) => (iso ? Math.floor(Date.parse(iso) / 1000) : null)

// {adx, signals:[{label,direction,ts,close}]} for one symbol + timeframe: the
// scanner summary (each indicator's latest crossover), or - when the symbol has
// no summary yet - the newest stored card for that timeframe.
function intervalData(entry, interval, fallback) {
  const summary = entry.scanState?.[interval]?.summary
  if (summary) return { adx: summary.adx, signals: summary.signals || [], lastClose: summary.lastClose }
  const card = fallback.get(`${entry.exchange}_${entry.symbol}_${interval}`)
  if (!card) return { adx: null, signals: [], lastClose: null }
  return { adx: card.adx, signals: (card.indicators || []).map((i) => ({ label: i.label, direction: i.direction, ts: card.candleTimestamp, close: card.closePrice })), lastClose: null }
}

/**
 * Pure: ordered symbols + fallback cards (Map `${exchange}_${symbol}_${interval}`
 * -> card, only for symbols without a scan summary) -> row value arrays. Page
 * filters (indicator, direction, adx, from/to) narrow which crossovers count;
 * with any of them (or a symbol filter) symbols left without a crossover are
 * dropped. Each row: {values: [...36 cells], colors, hasCrossover}.
 */
export function buildExportRows(symbols, fallback = new Map(), filters = {}) {
  const wantedColumns = filters.indicator?.length ? new Set(filters.indicator.map((l) => COLUMN_BY_LABEL.get(l)).filter((c) => c !== undefined)) : null
  const fromSec = toSeconds(filters.from)
  const toSec = toSeconds(filters.to)
  const narrowed = Boolean(filters.symbol || wantedColumns || filters.direction || filters.adx || fromSec != null || toSec != null)

  const rows = []
  for (const entry of symbols) {
    const picked = [] // {interval, col, signal, end}
    const blocks = []
    let lastClose = null
    for (const interval of TIMEFRAME_ORDER) {
      const data = intervalData(entry, interval, fallback)
      if (lastClose == null && Number.isFinite(data.lastClose)) lastClose = data.lastClose
      const adxTrend = data.adx?.trend
      const adxOk = !filters.adx || adxTrend === filters.adx
      const cells = INDICATOR_COLUMNS.map(() => null)
      if (adxOk) {
        for (const signal of data.signals) {
          const col = COLUMN_BY_LABEL.get(signal.label)
          if (col === undefined || (wantedColumns && !wantedColumns.has(col))) continue
          if (filters.direction && signal.direction !== filters.direction) continue
          const end = barEndOf(interval, signal.ts)
          if ((fromSec != null && end < fromSec) || (toSec != null && end > toSec)) continue
          if (!cells[col] || signal.ts > cells[col].signal.ts) cells[col] = { signal, end }
        }
      }
      cells.forEach((cell, col) => cell && picked.push({ interval, col, ...cell }))
      blocks.push({ adx: adxOk && ADX_TEXT[adxTrend] ? ADX_TEXT[adxTrend] : '', cells })
    }
    if (narrowed && picked.length === 0) continue

    const newest = picked.reduce((best, p) => (!best || p.end > best.end ? p : best), null)
    const bullish = picked.filter((p) => p.signal.direction === 'bullish').length
    const bearish = picked.length - bullish
    const bias = picked.length === 0 ? '' : bullish > bearish ? 'Bullish' : bearish > bullish ? 'Bearish' : 'Mixed'
    const values = [entry.symbol, bias, finiteOrBlank(lastClose ?? newest?.signal.close), finiteOrBlank(newest?.signal.close), newest ? formatIst(newest.end) : '', finiteOrBlank(entry.nrmlMargin)]
    const colors = {}
    for (const { adx, cells } of blocks) {
      values.push(adx)
      for (const cell of cells) {
        const colIndex = values.length // 0-based, before push
        if (cell) {
          const bull = cell.signal.direction === 'bullish'
          values.push(`${bull ? 'YES - Bullish' : 'YES - Bearish'} · ${formatIst(cell.end)}`)
          colors[colIndex] = bull ? GREEN : RED
        } else values.push('NO')
      }
    }
    rows.push({ values, colors, hasCrossover: picked.length > 0 })
  }
  return rows
}

function writeHeader(sheet) {
  sheet.mergeCells('A1:C1')
  const row1 = sheet.getRow(1)
  const row2 = sheet.getRow(2)
  const row3 = sheet.getRow(3)
  ;['SYMBOL', 'Bullish/ Bearish', 'Price', 'Price', 'Crossover Time', 'NRML Margin'].forEach((text, i) => {
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
      row3.getCell(start + 1 + i).value = HINT
    })
  })
  for (const row of [row1, row2, row3]) row.eachCell((cell) => (cell.font = cell.font?.name ? cell.font : BASE_FONT))
  for (let c = 1; c <= 3; c++) row2.getCell(c).font = SYMBOL_FONT
}

// `filters` = the Notifications page filters (parseNotificationFilters shape).
// Every symbol's per-indicator latest crossover, whatever day it was; From/To
// keep only crossovers inside that range.
export async function buildNotificationWorkbook(filters = {}) {
  const symbols = filters.type && filters.type !== 'crossover' ? [] : (await listActiveScannerSymbols()).filter((e) => !filters.symbol || e.symbol === filters.symbol)
  // Symbols the scanner has no summary for yet fall back to their newest stored card.
  const pairs = symbols.flatMap((entry) => TIMEFRAME_ORDER.filter((interval) => !entry.scanState?.[interval]?.summary).map((interval) => ({ entry, interval })))
  const fallback = pairs.length ? await listLatestGroupsForPairs(pairs, { from: filters.from, to: filters.to }) : new Map()
  const rows = buildExportRows(symbols, fallback, filters)
  const range = { from: filters.from, to: filters.to }
  const withCrossover = rows.filter((r) => r.hasCrossover).length
  return { workbook: renderWorkbook(rows, range), range, cardCount: rows.reduce((n, r) => n + r.values.filter((v) => typeof v === 'string' && v.startsWith('YES')).length, 0), symbolCount: withCrossover }
}

export function renderWorkbook(rows, range = {}) {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'GrowTest Crossover Scanner'
  workbook.title = `Notification List ${istDay(new Date())}`
  const sheet = workbook.addWorksheet('Notification List', {
    properties: { defaultColWidth: 12.63, defaultRowHeight: 15.75 },
    views: [{ state: 'frozen', xSplit: 1, ySplit: 3 }],
  })
  // Wide enough for "YES - Bearish · 06 Nov 26 15:15".
  sheet.getColumn(1).width = 16
  sheet.getColumn(5).width = 19.13
  sheet.getColumn(6).width = 14
  for (let c = FIRST_BLOCK_COL; c <= FIRST_BLOCK_COL + TIMEFRAME_ORDER.length * BLOCK_WIDTH - 1; c++) sheet.getColumn(c).width = (c - FIRST_BLOCK_COL) % BLOCK_WIDTH === 0 ? 14 : 29

  writeHeader(sheet)
  rows.forEach(({ values, colors }, r) => {
    const row = sheet.getRow(4 + r)
    values.forEach((value, c) => {
      const cell = row.getCell(c + 1)
      cell.value = value
      cell.font = c === 0 ? SYMBOL_FONT : colors[c] ? { ...BASE_FONT, bold: true, color: { argb: colors[c] } } : BASE_FONT
    })
  })
  const legend = 4 + rows.length + 1
  const rangeText = range.from || range.to ? `Only crossovers between ${range.from ? istDay(new Date(range.from)) : '...'} and ${range.to ? istDay(new Date(range.to)) : '...'}. ` : ''
  sheet.getCell(legend, 1).value = `One row per symbol. Each indicator shows its own latest crossover with the date and time it happened (IST): YES - Bullish (green) / YES - Bearish (red); NO = it has not crossed in the loaded history. ${rangeText}Crossover Time = the symbol's newest crossover; NRML Margin = the value saved on the Scanner page; ADX Trend = ADX on the timeframe's latest bar.`
  sheet.getCell(legend, 1).font = { ...BASE_FONT, italic: true }
  return workbook
}
