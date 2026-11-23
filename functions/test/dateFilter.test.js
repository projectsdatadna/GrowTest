import test from 'node:test'
import assert from 'node:assert/strict'
import { extractDateFilter, findAllDates, istToday } from '../assistant/dateFilter.js'

const NOW = new Date('2026-11-23T04:00:00Z') // Monday 23 Nov 2026, 09:30 IST
const f = (q) => extractDateFilter(q, { now: NOW })

test('dates: explicit, several formats, yearless resolves to the latest past date', () => {
  assert.deepEqual(f('What did FIIs do on 14 Nov 2025?').dates, ['2025-11-14'])
  assert.deepEqual(f('FII on 14/11/2025').dates, ['2025-11-14'])
  assert.deepEqual(f('FII on 2025-11-14').dates, ['2025-11-14'])
  assert.deepEqual(f('FII on Nov 14, 2025').dates, ['2025-11-14'])
  assert.deepEqual(f('as of 14th November').dates, ['2026-11-14'])
  assert.deepEqual(f('what about 25 dec?').dates, ['2025-12-25'], 'a future yearless date means last year')
  assert.deepEqual(f('FII on 14-Nov-25').dates, ['2025-11-14'])
})

test('dates: two dates compare exactly, between/from-to makes a range', () => {
  const cmp = f('Compare 14 Nov 2025 with 10 Nov 2025')
  assert.deepEqual(cmp.dates, ['2025-11-10', '2025-11-14'])
  assert.equal(cmp.range, null)
  assert.deepEqual(f('FII flows between 10 Nov and 14 Nov').range, { from: '2026-11-10', to: '2026-11-14' })
  assert.deepEqual(f('from 1 Oct 2025 to 31 Oct 2025').range, { from: '2025-10-01', to: '2025-10-31' })
})

test('dates: relative phrases in IST (today is Monday 23 Nov 2026)', () => {
  assert.deepEqual(f('what happened yesterday').dates, ['2026-11-22'])
  assert.deepEqual(f("today's FII data").dates, ['2026-11-23'])
  assert.deepEqual(f('last 7 days of FII selling').range, { from: '2026-11-17', to: '2026-11-23' })
  assert.deepEqual(f('last week').range, { from: '2026-11-16', to: '2026-11-22' })
  assert.deepEqual(f('this week').range, { from: '2026-11-23', to: '2026-11-23' })
  assert.deepEqual(f('last month summary').range, { from: '2026-10-01', to: '2026-10-31' })
  assert.deepEqual(f('this month').range, { from: '2026-11-01', to: '2026-11-23' })
  assert.deepEqual(f('FII activity in October').range, { from: '2026-10-01', to: '2026-10-31' })
  assert.deepEqual(f('in December').range, { from: '2025-12-01', to: '2025-12-31' })
  assert.deepEqual(f('November 2025 totals').range, { from: '2025-11-01', to: '2025-11-30' })
  assert.equal(f('give me the latest report').latest, true)
  assert.deepEqual(istToday(new Date('2026-11-22T20:00:00Z')), new Date('2026-11-23T00:00:00Z'), 'IST is ahead of UTC')
})

test('dates: no false positives from plain words or numbers', () => {
  for (const q of ['What is the net position?', 'it may be bullish', 'FII sold 1200 crore', 'March of the markets', 'Nifty at 24500']) {
    const r = f(q)
    assert.deepEqual([r.dates, r.range, r.latest], [[], null, false], q)
  }
  assert.deepEqual(findAllDates('31/02/2025 and 14 Nov 2025', istToday(NOW)).map((d) => d.toISOString().slice(0, 10)), ['2025-11-14'])
})
