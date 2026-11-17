import test from 'node:test'
import assert from 'node:assert/strict'
import { tickOf, pickNearestExpiry, compactChain, buildOptionChainDiff } from '../optionChainIntervalSnapshots.js'

const leg = (ltp, oi, iv, greeks = {}) => ({ ltp, open_interest: oi, greeks: { iv, ...greeks } })

test('tickOf floors to 15 minutes', () => {
  assert.equal(tickOf(900 * 10 + 899), 9000)
  assert.equal(tickOf(9000), 9000)
})

test('pickNearestExpiry takes the earliest date on/after today, both shapes', () => {
  assert.equal(pickNearestExpiry({ payload: { expiries: ['2025-02-27', '2025-01-30', '2025-01-02'] } }, '2025-01-10'), '2025-01-30')
  assert.equal(pickNearestExpiry({ expiry_dates: ['2025-01-10'] }, '2025-01-10'), '2025-01-10')
  assert.equal(pickNearestExpiry({}, '2025-01-10'), null)
})

test('compactChain keeps ATM +/- N strikes as an array', () => {
  const strikes = {}
  for (const k of [100, 110, 120, 130, 140, 150]) strikes[k] = { CE: leg(1, 10, 0.2), PE: leg(2, 20, 0.3) }
  const out = compactChain(strikes, 131, 1)
  assert.deepEqual(out.map((s) => s.strike), [120, 130, 140])
  assert.deepEqual(out[1].ce, { ltp: 1, oi: 10, iv: 0.2, delta: null, gamma: null, theta: null, vega: null, rho: null })
})

test('diff: prev, curr, difference, % and the 5% flag', () => {
  const prev = { strikes: [{ strike: 100, ce: { ltp: 10, oi: 1000, iv: null }, pe: { ltp: 5, oi: 0, iv: null } }] }
  const curr = { strikes: [{ strike: 100, ce: { ltp: 10.5, oi: 940, iv: null }, pe: { ltp: 4, oi: 50, iv: null } }] }
  const rows = buildOptionChainDiff(prev, curr)
  const find = (side, metric) => rows.find((r) => r.side === side && r.metric === metric)
  assert.deepEqual(find('CE', 'LTP'), { strike: 100, side: 'CE', metric: 'LTP', prev: 10, curr: 10.5, diff: 0.5, pct: 5, flag: true }) // exactly 5% flags
  assert.equal(find('CE', 'OI').pct, -6)
  assert.equal(find('CE', 'OI').flag, true)
  assert.equal(find('PE', 'OI').pct, null) // prev = 0 -> no %
  assert.equal(find('PE', 'OI').flag, false)
  assert.equal(find('CE', 'IV'), undefined) // both missing -> no row
})

test('diff: strike present on one side only still listed', () => {
  const rows = buildOptionChainDiff({ strikes: [] }, { strikes: [{ strike: 90, ce: { ltp: 1, oi: 2, iv: null }, pe: null }] })
  assert.equal(rows.find((r) => r.metric === 'OI').prev, null)
  assert.equal(rows.find((r) => r.metric === 'OI').diff, null)
})

test('compactChain stores the Greeks, keeps 0 as 0, null when missing', () => {
  const strikes = {
    100: { CE: leg(5, 10, 20, { delta: 0.5, gamma: 0, theta: -7.65, vega: 0.0138, rho: 0.05 }), PE: { ltp: 1, open_interest: 2 } },
  }
  const [row] = compactChain(strikes, 100, 1)
  assert.deepEqual(row.ce, { ltp: 5, oi: 10, iv: 20, delta: 0.5, gamma: 0, theta: -7.65, vega: 0.0138, rho: 0.05 })
  assert.deepEqual(row.pe, { ltp: 1, oi: 2, iv: null, delta: null, gamma: null, theta: null, vega: null, rho: null })
})

test('diff includes Greeks rows; a zero previous value gives no %', () => {
  const g = (delta, gamma) => ({ strikes: [{ strike: 100, ce: { ltp: null, oi: null, iv: null, delta, gamma, theta: null, vega: null, rho: null }, pe: null }] })
  const rows = buildOptionChainDiff(g(0.5, 0), g(0.55, 0.0002))
  const find = (metric) => rows.find((r) => r.side === 'CE' && r.metric === metric)
  assert.deepEqual(find('Delta'), { strike: 100, side: 'CE', metric: 'Delta', prev: 0.5, curr: 0.55, diff: 0.05, pct: 10, flag: true })
  assert.equal(find('Gamma').diff, 0.0002)
  assert.equal(find('Gamma').pct, null)
  assert.equal(find('Gamma').flag, false)
  assert.equal(find('Theta'), undefined)
})
