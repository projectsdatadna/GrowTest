import test from 'node:test'
import assert from 'node:assert/strict'
import { parseQuote } from '../growwQuotes.js'

test('parseQuote maps Groww fields and rounds', () => {
  const q = parseQuote({ day_change: 8.200000000000045, day_change_perc: 0.6120773307456927, last_price: 1347.9, ohlc: { close: 1339.7 } })
  assert.deepEqual(q, { dayChange: 8.2, dayChangePct: 0.61, lastPrice: 1347.9, prevClose: 1339.7 })
})
test('parseQuote returns null when the change is missing', () => {
  assert.equal(parseQuote({ last_price: 1 }), null)
  assert.equal(parseQuote(undefined), null)
})
