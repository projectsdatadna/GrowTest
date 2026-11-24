import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { builtInLot, resolveLotSize, validateLotSizeInput, BUILT_IN_LOT_COUNT } from '../lotSizes.js'
import { parseLotSize } from '../stopTargetCalc.js'

const table = JSON.parse(readFileSync(new URL('../data/lotSizes.json', import.meta.url), 'utf8'))

test('built-in table: from sheet 2 (known values, truncated names resolved), the verify flags, no junk', () => {
  assert.ok(BUILT_IN_LOT_COUNT >= 223)
  const known = { VEDL: 1150, PIIND: 175, ITC: 1725, 'M&M': 200, 'BAJAJ-AUTO': 75, 'GVT&D': 125, NIFTY: 65, BANKNIFTY: 30 }
  for (const [symbol, lot] of Object.entries(known)) assert.equal(builtInLot(symbol)?.lotSize, lot, symbol)
  for (const [symbol, lot] of Object.entries(table.lots)) assert.ok(Number.isInteger(lot) && lot > 0, `${symbol} has a bad lot size ${lot}`)
  assert.ok(!('#N/A' in table.lots) && !('NIFTYFPI' in table.lots) && !('M' in table.lots) && !('BAJAJ' in table.lots), 'only scanner symbol names, no sheet leftovers')
  assert.deepEqual(table.verify, ['360ONE', 'IEX', 'IREDA'])
  assert.deepEqual([builtInLot('IEX'), builtInLot('VEDL'), builtInLot('NIFTYAUTO'), builtInLot(undefined)], [{ lotSize: 3750, verify: true }, { lotSize: 1150, verify: false }, null, null])
})

test('resolution order: typed on the card > uploaded sheet > built-in table > none', () => {
  assert.deepEqual(resolveLotSize({ symbol: 'VEDL', lotSizeOverride: 1200, lotSize: 1100 }), { lotSize: 1200, lotSizeSource: 'user' })
  assert.deepEqual(resolveLotSize({ symbol: 'VEDL', lotSize: 1100 }), { lotSize: 1100, lotSizeSource: 'sheet' })
  assert.deepEqual(resolveLotSize({ symbol: 'VEDL' }), { lotSize: 1150, lotSizeSource: 'builtin' })
  assert.deepEqual(resolveLotSize({ symbol: 'IEX' }), { lotSize: 3750, lotSizeSource: 'verify' })
  assert.deepEqual(resolveLotSize({ symbol: 'IEX', lotSizeOverride: 3500 }), { lotSize: 3500, lotSizeSource: 'user' })
  assert.deepEqual(resolveLotSize({ symbol: 'NIFTYAUTO' }), { lotSize: null, lotSizeSource: null })
  assert.deepEqual(resolveLotSize({ symbol: 'VEDL', lotSizeOverride: 0, lotSize: null }), { lotSize: 1150, lotSizeSource: 'builtin' }, 'a bad stored value is ignored')
  assert.deepEqual(resolveLotSize(null), { lotSize: null, lotSizeSource: null })
})

test('lot size input: a whole number sets it, empty resets it, anything else is rejected (route and card editor share the rule)', () => {
  assert.equal(validateLotSizeInput, parseLotSize, 'one shared rule')
  for (const [input, expected] of [[1150, 1150], ['1,150', 1150], [' 75 ', 75], [null, null], ['', null], [undefined, null]]) assert.deepEqual(parseLotSize(input), { value: expected }, String(input))
  for (const bad of [0, -5, 12.5, '12.5', 'abc', '1e3x', NaN, true, 10000001, {}]) assert.ok('error' in parseLotSize(bad), `should reject ${String(bad)}`)
  assert.deepEqual(validateLotSizeInput('2,750'), { value: 2750 })
})
