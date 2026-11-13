import test from 'node:test'
import assert from 'node:assert/strict'
import { sortGroups, isDefaultGroupOrder } from '../crossoverGroupSort.js'

const g = (symbol, candleTimestamp, closePrice, sortOrder = 0) => ({ symbol, candleTimestamp, closePrice, sortOrder })
const data = [g('TCS', 300, 4000, 2), g('ACC', 100, 2000, 3), g('INFY', 200, null, 1), g('BEL', 200, 300, 4)]
const names = (list) => list.map((x) => x.symbol).join(',')

test('alphabetic, ascending and descending', () => {
  assert.equal(names(sortGroups(data, 'alpha', 'asc')), 'ACC,BEL,INFY,TCS')
  assert.equal(names(sortGroups(data, 'alpha', 'desc')), 'TCS,INFY,BEL,ACC')
})

test('stock value: cards without a price always go last', () => {
  assert.equal(names(sortGroups(data, 'price', 'asc')), 'BEL,ACC,TCS,INFY')
  assert.equal(names(sortGroups(data, 'price', 'desc')), 'TCS,ACC,BEL,INFY')
})

test('time: newest first by default, ties by list order', () => {
  assert.equal(names(sortGroups(data, 'time', 'desc')), 'TCS,INFY,BEL,ACC')
  assert.equal(names(sortGroups(data, 'time', 'asc')), 'ACC,INFY,BEL,TCS')
})

test('does not mutate its input; only time/desc is the Firestore default order', () => {
  const copy = [...data]
  sortGroups(data, 'alpha', 'asc')
  assert.deepEqual(data, copy)
  assert.equal(isDefaultGroupOrder(), true)
  assert.equal(isDefaultGroupOrder('time', 'asc'), false)
  assert.equal(isDefaultGroupOrder('alpha', 'desc'), false)
})

test('timeindex: newest bar first, indices before stocks inside a bar', () => {
  const rows = [
    { symbol: 'TCS', candleTimestamp: 200, isIndex: false, sortOrder: 1 },
    { symbol: 'NIFTY', candleTimestamp: 200, isIndex: true, sortOrder: 9 },
    { symbol: 'ACC', candleTimestamp: 300, isIndex: false, sortOrder: 2 },
    { symbol: 'BANKNIFTY', candleTimestamp: 100, isIndex: true, sortOrder: 0 },
  ]
  assert.equal(names(sortGroups(rows, 'timeindex', 'desc')), 'ACC,NIFTY,TCS,BANKNIFTY')
})

test('nrml margin: sorts by margin, cards without one always last', () => {
  const rows = [
    { symbol: 'TCS', nrmlMargin: 500 },
    { symbol: 'ACC', nrmlMargin: null },
    { symbol: 'INFY', nrmlMargin: 1500 },
    { symbol: 'BEL', nrmlMargin: 100 },
  ]
  assert.equal(names(sortGroups(rows, 'nrml', 'asc')), 'BEL,TCS,INFY,ACC')
  assert.equal(names(sortGroups(rows, 'nrml', 'desc')), 'INFY,TCS,BEL,ACC')
})
