/**
 * FII reports API.
 *   GET  /fii/dates          report dates available for comparison (newest first)
 *   GET  /fii/metrics/:docId extracted figures of one report
 *   POST /fii/extract/:docId re-run the extraction
 *   POST /fii/compare        { currentDate?, compareDate, force? } -> AI comparison (cached)
 */

import { compareFii, availableDates, pickDocForDate } from './fii/compare.js'
import { buildFiiDeps } from './fii/deps.js'

const DATE = /^\d{4}-\d{2}-\d{2}$/
const ID = /^[A-Za-z0-9]{10,40}$/

export function registerFiiRoutes(app, { deps } = {}) {
  let resolved = deps
  const getDeps = () => (resolved ??= buildFiiDeps())
  const guard = (handler) => async (req, res) => {
    try {
      await handler(req, res)
    } catch (error) {
      console.error(`Error in ${req.method} ${req.path}:`, error.message)
      res.status(500).json({ error: error.message })
    }
  }

  app.get('/fii/dates', guard(async (_req, res) => {
    const docs = await getDeps().listDocuments({ docType: 'fii_report', status: 'ready' })
    const dates = availableDates(docs).map((date) => {
      const doc = pickDocForDate(docs, date)
      return { date, docId: doc.id, title: doc.title }
    })
    res.json({ status: 'SUCCESS', dates })
  }))

  app.get('/fii/metrics/:docId', guard(async (req, res) => {
    if (!ID.test(req.params.docId)) return res.status(400).json({ error: 'Invalid document id' })
    const record = await getDeps().getMetrics(req.params.docId)
    if (!record) return res.status(404).json({ error: 'No metrics extracted for this document yet' })
    res.json({ status: 'SUCCESS', metrics: record })
  }))

  app.post('/fii/extract/:docId', guard(async (req, res) => {
    if (!ID.test(req.params.docId)) return res.status(400).json({ error: 'Invalid document id' })
    try {
      res.json({ status: 'SUCCESS', metrics: await getDeps().extract(req.params.docId) })
    } catch (error) {
      res.status(422).json({ error: error.message })
    }
  }))

  app.post('/fii/compare', guard(async (req, res) => {
    const { currentDate, compareDate, force } = req.body || {}
    if (typeof compareDate !== 'string' || !DATE.test(compareDate)) return res.status(400).json({ error: 'compareDate (YYYY-MM-DD) is required' })
    if (currentDate != null && !DATE.test(String(currentDate))) return res.status(400).json({ error: 'currentDate must be YYYY-MM-DD' })
    const result = await compareFii({ currentDate: currentDate || undefined, compareDate, force: force === true }, getDeps())
    if (result.status === 'INVALID') return res.status(400).json({ error: result.error })
    res.json(result)
  }))
}
