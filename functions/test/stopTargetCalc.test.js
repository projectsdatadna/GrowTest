import test from 'node:test'
import assert from 'node:assert/strict'
import { computeStopTarget, pickStockPrice, parseAmount, describeStopTarget } from '../stopTargetCalc.js'

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} !~ ${expected}`)

test('matches the Stp & Target sheet rows (SL 7500, target 17000)', () => {
  const abc = computeStopTarget({ slAmount: 7500, targetAmount: 17000, lotSize: 170, price: 1750 })
  near(abc.stoploss, 44.11764706)
  near(abc.stoplossPct, 2.521008403)
  near(abc.target, 100)
  near(abc.targetPct, 5.714285714)
  const xyz = computeStopTarget({ slAmount: 7500, targetAmount: 17000, lotSize: 325, price: 723 })
  near(xyz.stoploss, 23.07692308)
  near(xyz.stoplossPct, 3.191828918)
  near(xyz.target, 52.30769231)
  near(xyz.targetPct, 7.234812214)
})

test('missing inputs give null, not NaN/Infinity', () => {
  assert.deepEqual(computeStopTarget({ slAmount: 7500, targetAmount: 17000, lotSize: null, price: 100 }), { stoploss: null, stoplossPct: null, target: null, targetPct: null })
  assert.deepEqual(computeStopTarget({ slAmount: 7500, targetAmount: null, lotSize: 100, price: 0 }), { stoploss: 75, stoplossPct: null, target: null, targetPct: null })
  assert.equal(computeStopTarget({ slAmount: 0, targetAmount: 100, lotSize: 10, price: 50 }).stoploss, null)
})

test('price priority: live quote, then the bar close, then the (possibly stale) sheet price; amount parsing', () => {
  assert.deepEqual(pickStockPrice({ quote: { lastPrice: 10 }, closePrice: 30, sheetPrice: 20 }), { price: 10, source: 'live' })
  assert.deepEqual(pickStockPrice({ quote: null, closePrice: 30, sheetPrice: 20 }), { price: 30, source: 'close' }, 'a card with no live quote uses the bar close, not the older sheet price')
  assert.deepEqual(pickStockPrice({ quote: {}, closePrice: null, sheetPrice: 20 }), { price: 20, source: 'sheet' })
  assert.deepEqual(pickStockPrice({}), { price: null, source: null })
  assert.equal(parseAmount('₹7,500'), 7500)
  assert.equal(parseAmount(''), null)
  assert.equal(parseAmount('-5'), null)
})

test('what the column shows: off without amounts, a reason when there is no lot size, values otherwise', () => {
  const vedl = { symbol: 'VEDL', lotSize: 1150, closePrice: 237.85, sheetPrice: 180 }
  assert.deepEqual(describeStopTarget({ group: vedl, slAmount: null, targetAmount: null }), { state: 'off' })
  const both = describeStopTarget({ group: vedl, quote: { lastPrice: 250 }, slAmount: 7500, targetAmount: 17000 })
  assert.equal(both.state, 'ok')
  assert.deepEqual([both.lotSize, both.price, both.priceSource], [1150, 250, 'live'])
  near(both.stoploss, 7500 / 1150)
  near(both.stoplossPct, (7500 / 1150 / 250) * 100)
  near(both.targetPct, (17000 / 1150 / 250) * 100)
  const noQuote = describeStopTarget({ group: vedl, quote: null, slAmount: 7500, targetAmount: 17000 })
  assert.deepEqual([noQuote.price, noQuote.priceSource], [237.85, 'close'])
  const slOnly = describeStopTarget({ group: vedl, slAmount: 7500, targetAmount: null })
  assert.ok(slOnly.stoploss != null && slOnly.target === null && slOnly.targetPct === null)
  assert.deepEqual(describeStopTarget({ group: { symbol: 'HDFCBANK', lotSize: null }, slAmount: 7500 }), { state: 'noLot', reason: 'sheet' })
  assert.deepEqual(describeStopTarget({ group: { symbol: 'NIFTYAUTO', isIndex: true, lotSize: null }, slAmount: 7500 }), { state: 'noLot', reason: 'index' })
})
