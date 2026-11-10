/**
 * Crossover Scanner + unified Notifications HTTP routes. Registered by BOTH
 * the local dev server (root server.js) and the deployed function
 * (functions/index.js) through this one function, so - unlike the older
 * hand-duplicated routes in those two files - there is a single copy to
 * maintain. scripts/smoke.mjs's ROUTES table still needs the matching entries.
 *
 * Must be called BEFORE each app's catch-all 404 handler.
 */

import {
  listActiveScannerSymbols,
  addScannerSymbol,
  deactivateScannerSymbol,
  ensureSeeded,
  listCrossoverNotifications,
  getScannerSettings,
  saveScannerSettings,
  getRunStatus,
  listAllNotifications,
  listNotificationsSince,
  queryNotificationsPage,
  countNotificationsBySection,
  countNotificationsForDelete,
  deleteNotificationsInRange,
  NOTIFICATION_SECTIONS,
  countUnreadNotifications,
  markNotificationsRead,
  listOverview,
  setSymbolOrder,
  queryCrossoverGroupsPage,
  markCrossoverGroupsRead,
  markAllNotificationsAndGroupsRead,
  acquireManualRunLease,
  releaseManualRunLease,
} from './crossoverScannerFirestoreClient.js'
import { buildNotificationWorkbook } from './crossoverExport.js'
import { runDispatch, isIntervalDue } from './crossoverScanner.js'
import { searchInstruments } from './instrumentMasterSync.js'
import { TIMEFRAMES, TIMEFRAME_ORDER, MIN_AGREEMENT_RANGE, isTimeframe, latestExpectedBarEnd } from './crossoverTimeframes.js'

const SYMBOL_PATTERN = /^[A-Z0-9&-]{1,20}$/
const MAX_BULK_SYMBOLS = 300
// A saved priority order re-stamps every stored card, however old, so all views agree.
const ORDER_GROUP_DAYS = 3650
const MAX_MARK_READ_IDS = 1000
const CURSOR_OVERLAP_MS = 15000
const MAX_PAGE_SIZE = 100
const NOTIFICATION_TYPES = ['crossover', 'candles', 'analysis', 'scanner_warning']
// "Run now": each request scans for at most this long (the deployed API
// function times out at 120s); the client repeats while work remains.
const MANUAL_RUN_BUDGET_MS = 75000
const MANUAL_RUN_LEASE_MS = 150000
const EXPORT_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

const parseSymbolList = (raw) => {
  const list = Array.isArray(raw) ? raw : String(raw || '').split(/[\s,;]+/)
  // A pasted spreadsheet column usually carries its header ("SYMBOL") - skip it.
  // Set keeps the first occurrence, so list order survives de-duplication.
  return [...new Set(list.map((s) => String(s).trim().toUpperCase()).filter((s) => s && s !== 'SYMBOL'))]
}

// Filters shared by /notifications/page and /notifications/counts. Returns
// {error} for an unusable value. Everything is optional; symbol is upper-cased.
function parseNotificationFilters(query) {
  const filters = {}
  if (query.type) {
    if (!NOTIFICATION_TYPES.includes(query.type)) return { error: `type must be one of ${NOTIFICATION_TYPES.join(', ')}` }
    filters.type = query.type
  }
  if (query.direction) {
    if (!['bullish', 'bearish'].includes(query.direction)) return { error: 'direction must be bullish or bearish' }
    filters.direction = query.direction
  }
  // One label or a comma-separated list (labels contain no commas); several
  // become an `in` filter.
  if (query.indicator) {
    const list = [...new Set(String(query.indicator).split(',').map((s) => s.trim().slice(0, 60)).filter(Boolean))]
    if (list.length > 10) return { error: 'at most 10 indicators' }
    if (list.length) filters.indicator = list
  }
  if (query.symbol) filters.symbol = String(query.symbol).trim().toUpperCase().slice(0, 30)
  filters.unreadOnly = query.unreadOnly === 'true'
  const range = parseDateRange(query)
  if (range.error) return { error: range.error }
  if (range.from) filters.from = range.from
  if (range.to) filters.to = range.to
  return { filters }
}

// Optional ISO `from` / `to` (both inclusive). Returns {error} for an unparsable
// value or from > to.
function parseDateRange(source) {
  const out = {}
  for (const key of ['from', 'to']) {
    if (source[key] === undefined || source[key] === '') continue
    const ms = Date.parse(source[key])
    if (Number.isNaN(ms)) return { error: `${key} must be an ISO date/time` }
    out[key] = new Date(ms).toISOString()
  }
  if (out.from && out.to && out.from > out.to) return { error: 'from must not be after to' }
  return out
}

/**
 * Validates one symbol against the NSE/BSE instrument master (so a typo fails
 * here rather than as a recurring Groww error on every scan) and adds it.
 * Returns {status: 'added'|'exists'|'invalid'|'not-found', ...}.
 */
async function addValidatedSymbol(rawSymbol, rawExchange) {
  const symbol = String(rawSymbol || '').trim().toUpperCase()
  const exchange = String(rawExchange || 'NSE').trim().toUpperCase()
  if (!SYMBOL_PATTERN.test(symbol)) return { symbol, status: 'invalid', error: 'Invalid symbol' }

  const matches = await searchInstruments(symbol, 20)
  const match = matches.find((m) => m.symbol === symbol && m.exchange === exchange)
  if (!match) return { symbol, status: 'not-found', error: `${symbol} was not found on ${exchange} in the instrument list` }

  const { id, created } = await addScannerSymbol({ symbol, exchange, source: 'manual', instrumentType: match.instrumentType })
  return { symbol, id, status: created ? 'added' : 'exists' }
}

// {interval: n} with known intervals and n an integer within MIN_AGREEMENT_RANGE.
function validMinAgreement(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.entries(value).every(([interval, n]) => isTimeframe(interval) && Number.isInteger(n) && n >= MIN_AGREEMENT_RANGE[0] && n <= MIN_AGREEMENT_RANGE[1])
}

// The Scanner page polls the symbol list and has no use for the per-timeframe
// crossover summaries (those are for the Overview page and are bulky).
function withoutSummaries(entry) {
  const scanState = Object.fromEntries(Object.entries(entry.scanState || {}).map(([interval, { summary, ...rest }]) => [interval, rest]))
  return { ...entry, scanState }
}

function validIntervalList(value) {
  return Array.isArray(value) && value.every((i) => typeof i === 'string' && isTimeframe(i))
}

export function registerCrossoverScannerRoutes(app, { getGrowwAccessToken }) {
  // ---------- the one symbol list (used by every timeframe) ----------

  app.get('/crossover-scanner/symbols', async (_req, res) => {
    try {
      await ensureSeeded()
      const symbols = (await listActiveScannerSymbols()).map(withoutSummaries)
      res.json({ status: 'SUCCESS', symbols })
    } catch (error) {
      console.error('Error listing crossover scanner symbols:', error.message)
      res.status(500).json({ error: error.message })
    }
  })

  app.post('/crossover-scanner/symbols', async (req, res) => {
    try {
      const result = await addValidatedSymbol(req.body?.symbol, req.body?.exchange)
      if (result.status === 'invalid') return res.status(400).json({ error: result.error, required: ['symbol'] })
      if (result.status === 'not-found') return res.status(400).json({ error: result.error })
      res.json({ status: 'SUCCESS', id: result.id, created: result.status === 'added' })
    } catch (error) {
      console.error('Error adding crossover scanner symbol:', error.message)
      res.status(500).json({ error: error.message })
    }
  })

  // Paste many symbols once (comma / space / newline separated). Each is
  // validated independently; the response reports the outcome per symbol.
  // setOrder: true also makes the pasted order the display order (Notifications,
  // Overview, export) - e.g. Sheet1 of the notification list.
  app.post('/crossover-scanner/symbols/bulk', async (req, res) => {
    try {
      const unique = parseSymbolList(req.body?.symbols)
      if (unique.length === 0) return res.status(400).json({ error: 'No symbols provided', required: ['symbols'] })
      if (unique.length > MAX_BULK_SYMBOLS) return res.status(400).json({ error: `At most ${MAX_BULK_SYMBOLS} symbols per request` })

      const exchange = req.body?.exchange
      const results = []
      for (const symbol of unique) results.push(await addValidatedSymbol(symbol, exchange))
      const order = req.body?.setOrder === true ? await setSymbolOrder(unique) : null
      res.json({ status: 'SUCCESS', results, order })
    } catch (error) {
      console.error('Error bulk-adding crossover scanner symbols:', error.message)
      res.status(500).json({ error: error.message })
    }
  })

  // Display order only (no adds): symbols in list order; unlisted ones go last.
  app.put('/crossover-scanner/symbols/order', async (req, res) => {
    try {
      const unique = parseSymbolList(req.body?.symbols)
      if (unique.length === 0) return res.status(400).json({ error: 'No symbols provided', required: ['symbols'] })
      if (unique.length > MAX_BULK_SYMBOLS) return res.status(400).json({ error: `At most ${MAX_BULK_SYMBOLS} symbols per request` })
      res.json({ status: 'SUCCESS', ...(await setSymbolOrder(unique, { groupDays: ORDER_GROUP_DAYS })) })
    } catch (error) {
      console.error('Error saving crossover scanner symbol order:', error.message)
      res.status(500).json({ error: error.message })
    }
  })

  app.delete('/crossover-scanner/symbols/:id', async (req, res) => {
    try {
      await deactivateScannerSymbol(req.params.id)
      res.json({ status: 'SUCCESS' })
    } catch (error) {
      console.error('Error removing crossover scanner symbol:', error.message)
      res.status(500).json({ error: error.message })
    }
  })

  // ---------- settings + status ----------

  app.get('/crossover-scanner/settings', async (_req, res) => {
    try {
      res.json({ status: 'SUCCESS', settings: await getScannerSettings(), timeframes: TIMEFRAME_ORDER.map((interval) => ({ interval, label: TIMEFRAMES[interval].label })) })
    } catch (error) {
      console.error('Error reading crossover scanner settings:', error.message)
      res.status(500).json({ error: error.message })
    }
  })

  app.put('/crossover-scanner/settings', async (req, res) => {
    try {
      const { enabledIntervals, popupIntervals, minAgreement } = req.body || {}
      if (enabledIntervals !== undefined && !validIntervalList(enabledIntervals)) {
        return res.status(400).json({ error: 'enabledIntervals must be a list of known intervals', supported: TIMEFRAME_ORDER })
      }
      if (popupIntervals !== undefined && !validIntervalList(popupIntervals)) {
        return res.status(400).json({ error: 'popupIntervals must be a list of known intervals', supported: TIMEFRAME_ORDER })
      }
      if (minAgreement !== undefined && !validMinAgreement(minAgreement)) {
        return res.status(400).json({ error: `minAgreement must map known intervals to integers ${MIN_AGREEMENT_RANGE[0]}-${MIN_AGREEMENT_RANGE[1]}`, supported: TIMEFRAME_ORDER })
      }
      const settings = await saveScannerSettings({ enabledIntervals, popupIntervals, minAgreement })
      res.json({ status: 'SUCCESS', settings })
    } catch (error) {
      console.error('Error saving crossover scanner settings:', error.message)
      res.status(500).json({ error: error.message })
    }
  })

  // Overview page: every active symbol with each timeframe's crossover
  // summary (the most recent crossover per indicator), last processed bar and
  // any error. Read-only; the data is written on every scan.
  app.get('/crossover-scanner/overview', async (_req, res) => {
    try {
      res.json({ status: 'SUCCESS', symbols: await listOverview() })
    } catch (error) {
      console.error('Error reading crossover overview:', error.message)
      res.status(500).json({ error: error.message })
    }
  })

  // Per-timeframe view of the automatic scan: when it last ran, which bar
  // close is expected next, how many symbols are still due, plus token health.
  app.get('/crossover-scanner/status', async (_req, res) => {
    try {
      const [symbols, settings, runStatus] = await Promise.all([listActiveScannerSymbols(), getScannerSettings(), getRunStatus()])
      const nowSeconds = Math.floor(Date.now() / 1000)
      const intervals = TIMEFRAME_ORDER.map((interval) => ({
        interval,
        label: TIMEFRAMES[interval].label,
        enabled: settings.enabledIntervals.includes(interval),
        expectedBarEnd: latestExpectedBarEnd(interval, nowSeconds),
        dueSymbols: symbols.filter((s) => isIntervalDue(interval, s.scanState?.[interval], nowSeconds)).length,
        lastRun: runStatus.intervals?.[interval] || null,
      }))
      res.json({ status: 'SUCCESS', symbolCount: symbols.length, lastTickAt: runStatus.lastTickAt || null, token: runStatus.token || null, intervals })
    } catch (error) {
      console.error('Error reading crossover scanner status:', error.message)
      res.status(500).json({ error: error.message })
    }
  })

  // "Run now" (Crossover Scanner + Notifications pages): the same dispatcher
  // as the scheduled tick, on demand. Each request scans what is due for at
  // most MANUAL_RUN_BUDGET_MS and reports `remaining` (due work not started);
  // the client repeats until it is 0. Idempotent. A lease rejects a second
  // overlapping manual run with 409. Body {force: true} re-checks symbols
  // that are not due (it still only alerts on bars newer than the last one
  // scanned) - diagnostic only.
  app.post('/crossover-scanner/run', async (req, res) => {
    let leased = false
    try {
      leased = await acquireManualRunLease(MANUAL_RUN_LEASE_MS)
      if (!leased) return res.status(409).json({ error: 'A manual scan is already running - try again shortly' })
      const groww_token = await getGrowwAccessToken()
      const summary = await runDispatch({ groww_token, force: req.body?.force === true, budgetMs: MANUAL_RUN_BUDGET_MS })
      res.json({ status: 'SUCCESS', ...summary, remaining: summary.deferred })
    } catch (error) {
      console.error('Error running crossover scan:', error.message)
      res.status(error.statusCode || 500).json({ error: error.message })
    } finally {
      if (leased) await releaseManualRunLease().catch(() => {})
    }
  })

  // Excel export in the "Notification List" template layout (see
  // crossoverExport.js). Optional ISO from/to on the displayed crossover time;
  // without them, today (IST).
  app.get('/crossover-scanner/export.xlsx', async (req, res) => {
    try {
      const range = parseDateRange(req.query)
      if (range.error) return res.status(400).json({ error: range.error })
      const workbook = await buildNotificationWorkbook(range)
      const buffer = await workbook.xlsx.writeBuffer()
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())
      res.setHeader('Content-Type', EXPORT_CONTENT_TYPE)
      res.setHeader('Content-Disposition', `attachment; filename="Notification List ${day}.xlsx"`)
      res.send(Buffer.from(buffer))
    } catch (error) {
      console.error('Error exporting notifications:', error.message)
      res.status(500).json({ error: error.message })
    }
  })

  // Crossover alerts (newest first) plus which timeframes should pop up.
  app.get('/crossover-scanner/events', async (req, res) => {
    try {
      const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 300)
      const [events, settings] = await Promise.all([listCrossoverNotifications({ limit }), getScannerSettings()])
      res.json({ status: 'SUCCESS', events, popupIntervals: settings.popupIntervals })
    } catch (error) {
      console.error('Error listing crossover events:', error.message)
      res.status(500).json({ error: error.message })
    }
  })

  // ---------- unified notifications (every type, for the Notifications page) ----------

  app.get('/notifications', async (req, res) => {
    try {
      const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 300, 1), 500)
      const notifications = await listAllNotifications({ limit })
      res.json({ status: 'SUCCESS', notifications })
    } catch (error) {
      console.error('Error listing notifications:', error.message)
      res.status(500).json({ error: error.message })
    }
  })

  // Live feed: everything created after `cursor` (ISO), oldest first, plus the
  // popup settings so the client needs no second request. The server rewinds
  // the cursor by CURSOR_OVERLAP_MS; clients de-duplicate by id.
  app.get('/notifications/since', async (req, res) => {
    try {
      const cursorMs = Date.parse(req.query.cursor)
      if (Number.isNaN(cursorMs)) return res.status(400).json({ error: 'cursor must be an ISO timestamp', required: ['cursor'] })
      const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 500, 1), 500)
      const since = new Date(cursorMs - CURSOR_OVERLAP_MS)
      const [notifications, settings] = await Promise.all([listNotificationsSince({ since, limit }), getScannerSettings()])
      const newest = notifications.at(-1)?.createdAt || null
      res.json({ status: 'SUCCESS', notifications, cursor: newest, hasMore: notifications.length >= limit, popupIntervals: settings.popupIntervals, minAgreement: settings.minAgreement })
    } catch (error) {
      console.error('Error listing new notifications:', error.message)
      res.status(500).json({ error: error.message })
    }
  })

  // One numbered page of one section (a timeframe, or 'system'), newest first.
  app.get('/notifications/page', async (req, res) => {
    try {
      const section = String(req.query.section || '')
      if (!NOTIFICATION_SECTIONS.includes(section)) return res.status(400).json({ error: 'section must be a timeframe or system', supported: NOTIFICATION_SECTIONS })
      const { filters, error } = parseNotificationFilters(req.query)
      if (error) return res.status(400).json({ error })
      const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1)
      const pageSize = Math.min(Math.max(Number.parseInt(req.query.pageSize, 10) || 25, 1), MAX_PAGE_SIZE)
      const { items, total } = await queryNotificationsPage(section, filters, { page, pageSize })
      res.json({ status: 'SUCCESS', section, page, pageSize, total, notifications: items })
    } catch (error) {
      console.error('Error listing notifications page:', error.message)
      res.status(500).json({ error: error.message })
    }
  })

  // One numbered page of a timeframe's crossover groups (one card per symbol +
  // bar, every indicator that crossed merged in, stars = indicator count).
  // Index symbols always come first; then newest bar, then list order.
  app.get('/notifications/groups', async (req, res) => {
    try {
      const section = String(req.query.section || '')
      if (!TIMEFRAME_ORDER.includes(section)) return res.status(400).json({ error: 'section must be a timeframe', supported: TIMEFRAME_ORDER })
      const { filters, error } = parseNotificationFilters(req.query)
      if (error) return res.status(400).json({ error })
      const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1)
      const pageSize = Math.min(Math.max(Number.parseInt(req.query.pageSize, 10) || 25, 1), MAX_PAGE_SIZE)
      const { items, total, indexTotal } = await queryCrossoverGroupsPage(section, filters, { page, pageSize })
      res.json({ status: 'SUCCESS', section, page, pageSize, total, indexTotal, groups: items })
    } catch (error) {
      console.error('Error listing notification groups:', error.message)
      res.status(500).json({ error: error.message })
    }
  })

  // Per-section totals and unread counts under the same filters.
  app.get('/notifications/counts', async (req, res) => {
    try {
      const { filters, error } = parseNotificationFilters(req.query)
      if (error) return res.status(400).json({ error })
      res.json({ status: 'SUCCESS', sections: await countNotificationsBySection(filters) })
    } catch (error) {
      console.error('Error counting notifications:', error.message)
      res.status(500).json({ error: error.message })
    }
  })

  app.get('/notifications/unread-count', async (_req, res) => {
    try {
      res.json({ status: 'SUCCESS', count: await countUnreadNotifications() })
    } catch (error) {
      console.error('Error counting unread notifications:', error.message)
      res.status(500).json({ error: error.message })
    }
  })

  // Bulk delete by date range + sections. Everything is required so a request
  // can never wipe the whole collection by accident.
  const parseDeleteBody = (body = {}) => {
    const range = parseDateRange(body)
    if (range.error) return { error: range.error }
    if (!range.from || !range.to) return { error: 'from and to are required', required: ['from', 'to', 'intervals'] }
    const { intervals } = body
    if (!Array.isArray(intervals) || intervals.length === 0 || intervals.some((i) => !NOTIFICATION_SECTIONS.includes(i))) {
      return { error: 'intervals must be a non-empty list of timeframes (or system)', supported: NOTIFICATION_SECTIONS, required: ['from', 'to', 'intervals'] }
    }
    return { sections: [...new Set(intervals)], from: range.from, to: range.to }
  }

  app.post('/notifications/delete-preview', async (req, res) => {
    try {
      const parsed = parseDeleteBody(req.body)
      if (parsed.error) return res.status(400).json(parsed)
      res.json({ status: 'SUCCESS', count: await countNotificationsForDelete(parsed) })
    } catch (error) {
      console.error('Error previewing notification delete:', error.message)
      res.status(500).json({ error: error.message })
    }
  })

  app.post('/notifications/delete', async (req, res) => {
    try {
      const parsed = parseDeleteBody(req.body)
      if (parsed.error) return res.status(400).json(parsed)
      const { deleted, hasMore } = await deleteNotificationsInRange(parsed)
      res.json({ status: 'SUCCESS', deleted, hasMore })
    } catch (error) {
      console.error('Error deleting notifications:', error.message)
      res.status(500).json({ error: error.message })
    }
  })

  // {ids: notification ids, groupIds: crossover group ids} - at least one list.
  app.post('/notifications/mark-read', async (req, res) => {
    try {
      const validList = (list) => Array.isArray(list) && list.every((id) => typeof id === 'string' && id && !id.includes('/'))
      const ids = req.body?.ids ?? []
      const groupIds = req.body?.groupIds ?? []
      if (!validList(ids) || !validList(groupIds) || ids.length + groupIds.length === 0) {
        return res.status(400).json({ error: 'ids / groupIds must be lists of ids, and not both empty', required: ['ids'] })
      }
      if (ids.length + groupIds.length > MAX_MARK_READ_IDS) return res.status(400).json({ error: `At most ${MAX_MARK_READ_IDS} ids per request` })
      const [count] = await Promise.all([ids.length ? markNotificationsRead(ids) : 0, groupIds.length ? markCrossoverGroupsRead(groupIds) : 0])
      res.json({ status: 'SUCCESS', count })
    } catch (error) {
      console.error('Error marking notifications read:', error.message)
      res.status(500).json({ error: error.message })
    }
  })

  // Every unread notification and crossover group.
  app.post('/notifications/mark-all-read', async (_req, res) => {
    try {
      res.json({ status: 'SUCCESS', count: await markAllNotificationsAndGroupsRead() })
    } catch (error) {
      console.error('Error marking notifications read:', error.message)
      res.status(500).json({ error: error.message })
    }
  })
}
