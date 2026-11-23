import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { registerFiiRoutes } from '../fiiRoutes.js'

const docs = [
  { id: 'curdoc00001', title: 'FII 14 Nov', reportDate: '2025-11-14', uploadedAt: '2', processedAt: 'a' },
  { id: 'prevdoc0001', title: 'FII 10 Nov', reportDate: '2025-11-10', uploadedAt: '1', processedAt: 'b' },
]
async function start() {
  const metrics = { status: 'ready', warnings: [], metrics: { fii_cash_net: { value: -100, verified: true } } }
  const deps = {
    listDocuments: async () => docs, getMetrics: async () => metrics, extract: async () => metrics,
    listChunks: async () => [{ page: 1, text: 't' }], getCached: async () => null, saveCached: async () => {}, logUsage: async () => {},
    chat: async () => ({ message: { content: '{"headline":"h"}' }, usage: {} }),
  }
  const app = express()
  app.use(express.json())
  registerFiiRoutes(app, { deps })
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)) })
  return { base: `http://localhost:${server.address().port}`, close: () => { server.closeAllConnections(); server.close() } }
}
const post = (base, path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

test('fii routes: dates, compare (ok / missing date / invalid), metrics', async () => {
  const { base, close } = await start()
  assert.deepEqual((await (await fetch(`${base}/fii/dates`)).json()).dates.map((d) => d.date), ['2025-11-14', '2025-11-10'])
  const ok = await (await post(base, '/fii/compare', { compareDate: '2025-11-10' })).json()
  assert.equal(ok.status, 'SUCCESS')
  assert.equal(ok.analysis.headline, 'h')
  const missing = await (await post(base, '/fii/compare', { compareDate: '2025-11-12' })).json()
  assert.deepEqual([missing.status, missing.available], ['MISSING_DATE', ['2025-11-14', '2025-11-10']])
  assert.equal((await post(base, '/fii/compare', { compareDate: 'x' })).status, 400)
  assert.equal((await post(base, '/fii/compare', { currentDate: '2025-11-10', compareDate: '2025-11-10' })).status, 400)
  assert.equal((await fetch(`${base}/fii/metrics/bad!`)).status, 400)
  assert.equal((await fetch(`${base}/fii/metrics/curdoc00001`)).status, 200)
  close()
})
