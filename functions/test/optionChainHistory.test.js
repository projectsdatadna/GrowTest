import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { registerOptionChainHistoryRoutes } from '../optionChainHistoryRoutes.js'
import { istEpoch } from '../assistant/optionChainContext.js'

async function start(store) {
  const app = express()
  registerOptionChainHistoryRoutes(app, { store })
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)) })
  return { base: `http://localhost:${server.address().port}`, close: () => { server.closeAllConnections(); server.close() } }
}

test('GET /option-chain-history/slots: IST times, expiry and spot of one symbol on one day, oldest first', async () => {
  const asked = []
  const t = (time) => istEpoch('2026-11-24', time)
  const store = { listSlots: async (symbol, from, to) => { asked.push([symbol, from, to]); return [{ tick: t('09:15'), expiry: '2026-12-01', underlyingLtp: 25500 }, { tick: t('10:15'), expiry: '2026-12-01', underlyingLtp: 25550.5 }] } }
  const { base, close } = await start(store)
  const body = await (await fetch(`${base}/option-chain-history/slots?symbol=nifty&date=2026-11-24`)).json()
  assert.deepEqual(body.slots, [{ time: '09:15', expiry: '2026-12-01', underlyingLtp: 25500 }, { time: '10:15', expiry: '2026-12-01', underlyingLtp: 25550.5 }])
  assert.deepEqual(asked, [['NIFTY', istEpoch('2026-11-24', '00:00'), istEpoch('2026-11-24', '00:00') + 86400]])
  assert.deepEqual((await (await fetch(`${base}/option-chain-history/slots?symbol=NIFTY&date=2026-11-23`)).json()).slots.length, 2) // whatever the store returns
  close()
})

test('GET /option-chain-history/slots: bad symbol or date -> 400, a failing store -> 500 without leaking details', async () => {
  const { base, close } = await start({ listSlots: async () => { throw new Error('secret firestore detail') } })
  assert.equal((await fetch(`${base}/option-chain-history/slots?symbol=NI%20FTY&date=2026-11-24`)).status, 400)
  assert.equal((await fetch(`${base}/option-chain-history/slots?symbol=NIFTY&date=24-11-2026`)).status, 400)
  assert.equal((await fetch(`${base}/option-chain-history/slots?symbol=NIFTY&date=2026-13-45`)).status, 400)
  const failed = await fetch(`${base}/option-chain-history/slots?symbol=NIFTY&date=2026-11-24`)
  assert.equal(failed.status, 500)
  assert.doesNotMatch(JSON.stringify(await failed.json()), /secret/)
  close()
})

test('GET /option-chain-history/symbols: the symbols and the first and last day that have snapshots (IST)', async () => {
  const { base, close } = await start({ listSymbols: async () => ({ symbols: ['NIFTY', 'RELIANCE'], earliestTick: istEpoch('2026-11-02', '09:15'), latestTick: istEpoch('2026-11-27', '15:30') }) })
  assert.deepEqual(await (await fetch(`${base}/option-chain-history/symbols`)).json(), { status: 'SUCCESS', symbols: ['NIFTY', 'RELIANCE'], earliestDate: '2026-11-02', latestDate: '2026-11-27' })
  close()
})
