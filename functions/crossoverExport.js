/**
 * Excel export of the Notifications tab's LATEST data, on one sheet. One row per
 * merged crossover card (symbol + bar), all timeframes together, same filters
 * as the tab. With no date filter it covers the latest IST day that has
 * crossovers; with From/To it covers that range.
 *
 *   Timeframe | Crossed Time (IST) | Symbol | Index | Stars | Bullish | Bearish |
 *   Bias | RSI | DI | MACD | TSI | Stoch RSI | Other (SMA/EMA) | Close |
 *   ADX Current | ADX Previous | ADX Status | Read
 * Indicator cells: "YES - Bullish" (green) / "YES - Bearish" (red) / "NO".
 */

import ExcelJS from 'exceljs'
import { TIMEFRAME_ORDER, candleEnd } from './crossoverTimeframes.js'
import { latestCrossoverGroup, listCrossoverGroupsForExport } from './crossoverScannerFirestoreClient.js'

export const TIMEFRAME_SHEETS = { '15minute': '15 Mins', '1hour': '1 Hour', '4hour': '4 Hour', '1day': 'Daily', '1week': 'Weekly' }
const MAX_STARS = 7
const MAX_ROWS = 50000
const IST_OFFSET_SECONDS = 19800

// The five template indicator columns; any other label goes to "Other".
const INDICATOR_COLUMNS = [
  { header: 'RSI', labels: ['RSI 14/14'] },
  { header: 'DI', labels: ['DMI 14 (+DI/-DI)', 'ADX 14 (+DI/-DI)'] },
  { header: 'MACD', labels: ['MACD 12/26/9'] },
  { header: 'TSI', labels: ['TSI 25/13/13'] },
  { header: 'Stoch RSI', labels: ['Stoch RSI 14/14/3/3'] },
]
const COLUMN_BY_LABEL = new Map(INDICATOR_COLUMNS.flatMap((col, i) => col.labels.map((label) => [label, i])))
const ADX_TEXT = { increase: 'Increased', decrease: 'Decreased', flat: 'Flat' }
const GREEN = 'FF1E8E3E'
const RED = 'FFD93025'
const BASE_FONT = { name: 'Arial', size: 10 }
const HEADER_FONT = { name: 'Arial', size: 10, bold: true }
const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EAED' } }
const DATE_FORMAT = 'dd mmm yy hh:mm'

const finiteOrBlank = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : '')
const yesText = (direction) => (direction === 'bullish' ? 'YES - Bullish' : 'YES - Bearish')
// Excel has no time zones: store the IST wall-clock time as the cell's value.
const istCellDate = (epochSeconds) => (Number.isFinite(epochSeconds) ? new Date((epochSeconds + IST_OFFSET_SECONDS) * 1000) : '')

const TIMEFRAME_COLUMNS = [
  { header: 'Timeframe', width: 11 },
  { header: 'Crossed Time (IST)', width: 19, date: true },
  { header: 'Symbol', width: 16 },
  { header: 'Index', width: 8 },
  { header: 'Stars', width: 8 },
  { header: 'Bullish', width: 9 },
  { header: 'Bearish', width: 9 },
  { header: 'Bias', width: 10 },
  ...INDICATOR_COLUMNS.map((c) => ({ header: c.header, width: 15 })),
  { header: 'Other (SMA/EMA)', width: 30 },
  { header: 'Close', width: 11 },
  { header: 'ADX Current', width: 12 },
  { header: 'ADX Previous', width: 12 },
  { header: 'ADX Status', width: 12 },
  { header: 'Read', width: 8 },
]
/** Pure: cards (crossoverGroups docs, table order) -> {values, colors} rows. */
export function buildCardRows(groups) {
  return groups.map((g) => {
    const bullish = g.bullishCount || 0
    const bearish = g.bearishCount || 0
    const bias = bullish + bearish === 0 ? '' : bullish > bearish ? 'Bullish' : bearish > bullish ? 'Bearish' : 'Mixed'
    const cells = INDICATOR_COLUMNS.map(() => 'NO')
    const colors = {}
    const other = []
    for (const ind of g.indicators || []) {
      const col = COLUMN_BY_LABEL.get(ind.label)
      if (col === undefined) other.push(`${ind.label} ${ind.direction === 'bullish' ? 'Bullish' : 'Bearish'}`)
      else {
        cells[col] = yesText(ind.direction)
        colors[8 + col] = ind.direction === 'bullish' ? GREEN : RED
      }
    }
    const end = candleEnd(g.interval, g.candleTimestamp) ?? g.candleTimestamp
    const adx = g.adx
    const values = [
      TIMEFRAME_SHEETS[g.interval] || g.interval,
      istCellDate(end),
      g.symbol,
      g.isIndex ? 'INDEX' : '',
      `${g.stars ?? (g.indicators || []).length}/${MAX_STARS}`,
      bullish,
      bearish,
      bias,
      ...cells,
      other.join(', '),
      finiteOrBlank(g.closePrice),
      finiteOrBlank(adx?.value),
      finiteOrBlank(adx?.prev),
      adx && ADX_TEXT[adx.trend] ? ADX_TEXT[adx.trend] : '',
      g.read ? 'Read' : 'Unread',
    ]
    return { values, colors, bullish, bearish, unread: !g.read, crossovers: (g.indicators || []).length }
  })
}

const istFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' })
const istDay = (date) => istFormatter.format(date)
const istDayRange = (day) => ({ from: new Date(`${day}T00:00:00+05:30`).toISOString(), to: new Date(`${day}T23:59:59.999+05:30`).toISOString() })

// No date filter: the most recent IST day that has crossovers (falls back to
// today when nothing is stored). `day` is set only for this default.
export async function defaultExportRange(now = new Date()) {
  const latest = await latestCrossoverGroup()
  const end = latest ? (candleEnd(latest.interval, latest.candleTimestamp) ?? latest.candleTimestamp) : null
  const day = istDay(end ? new Date(Math.min(end * 1000, now.getTime())) : now)
  return { ...istDayRange(day), day }
}

// {from, to} the page asked for, or the latest day. One bound only: the other is
// the same IST day, never open-ended.
export async function resolveExportRange({ from, to } = {}) {
  if (!from && !to) return defaultExportRange()
  if (!from) return { from: istDayRange(istDay(new Date(to))).from, to }
  if (!to) return { from, to: istDayRange(istDay(new Date(from))).to }
  return { from, to }
}

function writeSheet(workbook, name, columns, rows) {
  const sheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] })
  sheet.columns = columns.map((c) => ({ header: c.header, width: c.width }))
  const header = sheet.getRow(1)
  header.eachCell((cell) => {
    cell.font = HEADER_FONT
    cell.fill = HEADER_FILL
  })
  rows.forEach(({ values, colors }, r) => {
    const row = sheet.getRow(2 + r)
    values.forEach((value, c) => {
      const cell = row.getCell(c + 1)
      cell.value = value
      if (columns[c].date && value instanceof Date) cell.numFmt = DATE_FORMAT
      cell.font = colors[c] ? { ...BASE_FONT, bold: true, color: { argb: colors[c] } } : BASE_FONT
    })
  })
  if (rows.length) sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1 + rows.length, column: columns.length } }
  else sheet.getCell(2, 1).value = 'No notifications match.'
  return sheet
}

const describeFilters = (f) => {
  const parts = []
  if (f.type) parts.push(`type: ${f.type}`)
  if (f.unreadOnly) parts.push('unread only')
  if (f.symbol) parts.push(`symbol: ${f.symbol}`)
  if (f.indicator?.length) parts.push(`indicators: ${f.indicator.join(', ')}`)
  if (f.direction) parts.push(`direction: ${f.direction}`)
  if (f.adx) parts.push(`ADX status: ${f.adx}`)
  return parts.length ? parts.join('; ') : 'none'
}

/**
 * Builds the single-sheet workbook for `filters` (the Notifications page filters,
 * see parseNotificationFilters). Returns {workbook, range, cardCount, symbolCount, truncated}.
 */
export async function buildNotificationWorkbook(filters = {}) {
  const range = await resolveExportRange({ from: filters.from, to: filters.to })
  const effective = { ...filters, from: range.from, to: range.to }
  const perTimeframe = await Promise.all(TIMEFRAME_ORDER.map((interval) => listCrossoverGroupsForExport(interval, effective, { limit: MAX_ROWS + 1 })))
  const all = buildCardRows(perTimeframe.flat())
  const truncated = all.length > MAX_ROWS
  const rows = truncated ? all.slice(0, MAX_ROWS) : all

  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'GrowTest Crossover Scanner'
  workbook.title = 'Notification List'
  const sheet = writeSheet(workbook, 'Notification List', TIMEFRAME_COLUMNS, rows)

  let next = 3 + rows.length
  const note = (text) => {
    sheet.getCell(next, 1).value = text
    sheet.getCell(next, 1).font = { ...BASE_FONT, italic: true }
    next += 1
  }
  const day = range.day || (range.from === range.to ? istDay(new Date(range.from)) : `${istDay(new Date(range.from))} to ${istDay(new Date(range.to))}`)
  note(`Crossed on (IST): ${range.day ? `${day} (latest day with crossovers)` : day} | Filters: ${describeFilters(filters)} | Cards: ${rows.length}`)
  if (truncated) note(`Showing the first ${MAX_ROWS} rows only - narrow the filters or date range to export the rest.`)
  note('Legend: YES - Bullish (green) = indicator crossed bullish on that bar; YES - Bearish (red) = crossed bearish; NO = did not cross on that bar.')
  note('Stars = distinct indicators that crossed on the bar. ADX Current/Previous = ADX at that bar vs the bar before; Status = Increased/Decreased/Flat. Other lists crossovers with no dedicated column.')

  return { workbook, range, cardCount: rows.length, symbolCount: new Set(rows.map((r) => r.values[2])).size, truncated }
}
