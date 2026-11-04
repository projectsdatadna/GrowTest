/**
 * Crossover Scanner HTTP routes. Registered by BOTH the local dev server
 * (root server.js) and the deployed function (functions/index.js) through
 * this one function, so - unlike the older hand-duplicated routes in those
 * two files - there is a single copy to maintain. scripts/smoke.mjs's ROUTES
 * table still needs the matching entries.
 *
 * Must be called BEFORE each app's catch-all 404 handler.
 */

import {
  listActiveScannerSymbols,
  addScannerSymbol,
  deactivateScannerSymbol,
  ensureSeeded,
  listCrossoverNotifications,
} from './crossoverScannerFirestoreClient.js'
import { runScan } from './crossoverScanner.js'
import { searchInstruments } from './instrumentMasterSync.js'

const SYMBOL_PATTERN = /^[A-Z0-9&-]{1,20}$/

export function registerCrossoverScannerRoutes(app, { getGrowwAccessToken }) {
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
      const symbol = String(req.body?.symbol || '').trim().toUpperCase()
      const exchange = String(req.body?.exchange || 'NSE').trim().toUpperCase()
      if (!SYMBOL_PATTERN.test(symbol)) {
        return res.status(400).json({ error: 'Invalid symbol', required: ['symbol'] })
      }

      // Reject anything not in the NSE/BSE instrument master, so a typo
      // fails here rather than as a recurring Groww error on every scan.
      const matches = await searchInstruments(symbol, 20)
      const known = matches.some((m) => m.symbol === symbol && m.exchange === exchange)
      if (!known) {
        return res.status(400).json({ error: `${symbol} was not found on ${exchange} in the instrument list` })
      }

      const { id, created } = await addScannerSymbol({ symbol, exchange, source: 'manual' })
      res.json({ status: 'SUCCESS', id, created })
    } catch (error) {
      console.error('Error adding crossover scanner symbol:', error.message)
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

  // Manual "Scan now". Also the only way to exercise the scan locally (no
  // local scheduler). Idempotent - already-alerted crossovers are not
  // re-alerted.
  app.post('/crossover-scanner/run', async (_req, res) => {
    try {
      const groww_token = await getGrowwAccessToken()
      const summary = await runScan({ groww_token })
      res.json({ status: 'SUCCESS', ...summary })
    } catch (error) {
      console.error('Error running crossover scan:', error.message)
      res.status(error.statusCode || 500).json({ error: error.message })
    }
  })

  app.get('/crossover-scanner/events', async (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200)
      const events = await listCrossoverNotifications({ limit })
      res.json({ status: 'SUCCESS', events })
    } catch (error) {
      console.error('Error listing crossover events:', error.message)
      res.status(500).json({ error: error.message })
    }
  })
}
