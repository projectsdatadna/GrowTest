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
  countUnreadNotifications,
  markNotificationsRead,
} from './crossoverScannerFirestoreClient.js'
import { runDispatch, isIntervalDue } from './crossoverScanner.js'
import { searchInstruments } from './instrumentMasterSync.js'
import { TIMEFRAMES, TIMEFRAME_ORDER, isTimeframe, latestExpectedBarEnd } from './crossoverTimeframes.js'

const SYMBOL_PATTERN = /^[A-Z0-9&-]{1,20}$/
const MAX_BULK_SYMBOLS = 100
const MAX_MARK_READ_IDS = 1000

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
  const known = matches.some((m) => m.symbol === symbol && m.exchange === exchange)
  if (!known) return { symbol, status: 'not-found', error: `${symbol} was not found on ${exchange} in the instrument list` }

  const { id, created } = await addScannerSymbol({ symbol, exchange, source: 'manual' })
  return { symbol, id, status: created ? 'added' : 'exists' }
}

function validIntervalList(value) {
  return Array.isArray(value) && value.every((i) => typeof i === 'string' && isTimeframe(i))
}

export function registerCrossoverScannerRoutes(app, { getGrowwAccessToken }) {
  // ---------- the one symbol list (used by every timeframe) ----------

  app.get('/crossover-scanner/symbols', async (_req, res) => {
    try {
      await ensureSeeded()
      const symbols = await listActiveScannerSymbols()
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
  app.post('/crossover-scanner/symbols/bulk', async (req, res) => {
    try {
      const raw = req.body?.symbols
      const list = Array.isArray(raw) ? raw : String(raw || '').split(/[\s,;]+/)
      const unique = [...new Set(list.map((s) => String(s).trim().toUpperCase()).filter(Boolean))]
      if (unique.length === 0) return res.status(400).json({ error: 'No symbols provided', required: ['symbols'] })
      if (unique.length > MAX_BULK_SYMBOLS) return res.status(400).json({ error: `At most ${MAX_BULK_SYMBOLS} symbols per request` })

      const exchange = req.body?.exchange
      const results = []
      for (const symbol of unique) results.push(await addValidatedSymbol(symbol, exchange))
      res.json({ status: 'SUCCESS', results })
    } catch (error) {
      console.error('Error bulk-adding crossover scanner symbols:', error.message)
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
      const { enabledIntervals, popupIntervals } = req.body || {}
      if (enabledIntervals !== undefined && !validIntervalList(enabledIntervals)) {
        return res.status(400).json({ error: 'enabledIntervals must be a list of known intervals', supported: TIMEFRAME_ORDER })
      }
      if (popupIntervals !== undefined && !validIntervalList(popupIntervals)) {
        return res.status(400).json({ error: 'popupIntervals must be a list of known intervals', supported: TIMEFRAME_ORDER })
      }
      const settings = await saveScannerSettings({ enabledIntervals, popupIntervals })
      res.json({ status: 'SUCCESS', settings })
    } catch (error) {
      console.error('Error saving crossover scanner settings:', error.message)
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

  // Diagnostic only - the UI has no "Scan now"; the scheduled dispatcher does
  // this automatically. Idempotent. Body {force: true} re-checks symbols that
  // are not due (it still only alerts on bars newer than the last one scanned).
  app.post('/crossover-scanner/run', async (req, res) => {
    try {
      const groww_token = await getGrowwAccessToken()
      const summary = await runDispatch({ groww_token, force: req.body?.force === true })
      res.json({ status: 'SUCCESS', ...summary })
    } catch (error) {
      console.error('Error running crossover scan:', error.message)
      res.status(error.statusCode || 500).json({ error: error.message })
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

  app.get('/notifications/unread-count', async (_req, res) => {
    try {
      res.json({ status: 'SUCCESS', count: await countUnreadNotifications() })
    } catch (error) {
      console.error('Error counting unread notifications:', error.message)
      res.status(500).json({ error: error.message })
    }
  })

  app.post('/notifications/mark-read', async (req, res) => {
    try {
      const ids = req.body?.ids
      if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== 'string' || id.includes('/'))) {
        return res.status(400).json({ error: 'ids must be a non-empty list of notification ids', required: ['ids'] })
      }
      if (ids.length > MAX_MARK_READ_IDS) return res.status(400).json({ error: `At most ${MAX_MARK_READ_IDS} ids per request` })
      const count = await markNotificationsRead(ids)
      res.json({ status: 'SUCCESS', count })
    } catch (error) {
      console.error('Error marking notifications read:', error.message)
      res.status(500).json({ error: error.message })
    }
  })
}
