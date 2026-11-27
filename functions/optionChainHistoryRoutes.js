/**
 * Saved option-chain snapshots, for the Assistant's Option Chain popup (past date + snapshot time).
 *   GET /option-chain-history/symbols              -> { symbols, earliestDate, latestDate }
 *   GET /option-chain-history/slots?symbol=&date=  -> { slots: [{ time: '10:15', expiry, underlyingLtp }] }
 * The snapshots are written every 15 minutes by the scheduler (optionChainIntervalSnapshots.js) for the
 * scanner's optionable symbols, nearest expiry only. Groww has no historical chain, so these are the only
 * past data there is.
 */

import { istEpoch } from './assistant/optionChainContext.js'
import { istDateString } from './optionChainIntervalSnapshots.js'

const SYMBOL = /^[A-Z0-9&-]{1,30}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const DAY = 86400

const defaultStore = {
  // Scanner symbols that have an option chain, the earliest and the latest stored tick.
  async listSymbols() {
    const [{ listActiveScannerSymbols, scannerDb }, { getUnderlyingSymbols }, { SNAPSHOT_COLLECTION }] = await Promise.all([
      import('./crossoverScannerFirestoreClient.js'),
      import('./firestoreClient.js'),
      import('./optionChainIntervalSnapshots.js'),
    ])
    const edge = async (direction) => {
      const r = await scannerDb.collection(SNAPSHOT_COLLECTION).orderBy('tick', direction).limit(1).select('tick').get()
      return r.empty ? null : r.docs[0].get('tick')
    }
    const [active, underlyings, earliestTick, latestTick] = await Promise.all([listActiveScannerSymbols(), getUnderlyingSymbols(), edge('asc'), edge('desc')])
    const optionable = new Set(underlyings)
    return { symbols: active.map((s) => s.symbol).filter((s) => optionable.has(s)), earliestTick, latestTick }
  },
  // Snapshots of one symbol with startTick <= tick < endTick, oldest first.
  async listSlots(symbol, startTick, endTick) {
    const [{ scannerDb }, { SNAPSHOT_COLLECTION }] = await Promise.all([import('./crossoverScannerFirestoreClient.js'), import('./optionChainIntervalSnapshots.js')])
    const r = await scannerDb
      .collection(SNAPSHOT_COLLECTION)
      .where('symbol', '==', symbol)
      .where('tick', '>=', startTick)
      .where('tick', '<', endTick)
      .orderBy('tick', 'desc')
      .select('tick', 'expiry', 'underlyingLtp')
      .get()
    return r.docs.map((d) => d.data()).reverse()
  },
}

const istTime = (tick) => new Date((tick + 19800) * 1000).toISOString().slice(11, 16)
const dateOfTick = (tick) => (tick == null ? null : istDateString(new Date(tick * 1000)))

export function registerOptionChainHistoryRoutes(app, { store = defaultStore } = {}) {
  app.get('/option-chain-history/symbols', async (_req, res) => {
    try {
      const { symbols, earliestTick, latestTick } = await store.listSymbols()
      res.json({ status: 'SUCCESS', symbols, earliestDate: dateOfTick(earliestTick), latestDate: dateOfTick(latestTick) })
    } catch (err) {
      console.error('Error in GET /option-chain-history/symbols:', err.message)
      res.status(500).json({ error: 'Could not read the saved option chains' })
    }
  })

  app.get('/option-chain-history/slots', async (req, res) => {
    const symbol = String(req.query.symbol ?? '').trim().toUpperCase()
    const date = String(req.query.date ?? '').trim()
    if (!SYMBOL.test(symbol)) return res.status(400).json({ error: 'Pick a valid symbol' })
    if (!DATE.test(date) || Number.isNaN(istEpoch(date, '00:00'))) return res.status(400).json({ error: 'Pick a valid date (YYYY-MM-DD)' })
    try {
      const start = istEpoch(date, '00:00')
      const ticks = await store.listSlots(symbol, start, start + DAY)
      res.json({ status: 'SUCCESS', symbol, date, slots: ticks.map((t) => ({ time: istTime(t.tick), expiry: t.expiry ?? null, underlyingLtp: t.underlyingLtp ?? null })) })
    } catch (err) {
      console.error('Error in GET /option-chain-history/slots:', err.message)
      res.status(500).json({ error: 'Could not read the saved option chains' })
    }
  })
}
