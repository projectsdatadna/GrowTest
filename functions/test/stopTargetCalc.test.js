import test from 'node:test'
import assert from 'node:assert/strict'
import { computeStopTarget, pickStockPrice, parseAmount } from '../stopTargetCalc.js'

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

test('price priority live > sheet > close; amount parsing', () => {
  assert.deepEqual(pickStockPrice({ quote: { lastPrice: 10 }, sheetPrice: 20, closePrice: 30 }), { price: 10, source: 'live' })
  assert.deepEqual(pickStockPrice({ quote: null, sheetPrice: 20, closePrice: 30 }), { price: 20, source: 'sheet' })
  assert.deepEqual(pickStockPrice({ quote: {}, sheetPrice: null, closePrice: 30 }), { price: 30, source: 'close' })
  assert.deepEqual(pickStockPrice({}), { price: null, source: null })
  assert.equal(parseAmount('₹7,500'), 7500)
  assert.equal(parseAmount(''), null)
  assert.equal(parseAmount('-5'), null)
})
