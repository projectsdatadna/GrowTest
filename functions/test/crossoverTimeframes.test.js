import test from 'node:test'
import assert from 'node:assert/strict'
import { candleEnd, isCandleClosed, latestExpectedBarEnd } from '../crossoverTimeframes.js'

// IST wall-clock -> epoch seconds
const ist = (iso) => Math.floor(Date.parse(`${iso}+05:30`) / 1000)

test('15-min: the 09:00 pre-open bar is not a trading bar', () => {
  assert.equal(candleEnd('15minute', ist('2026-11-11T09:00:00')), null)
  assert.equal(isCandleClosed('15minute', ist('2026-11-11T09:00:00'), ist('2026-11-11T16:00:00')), false)
})

test('15-min: first real bar is 09:15-09:30, last is 15:15-15:30, 15:45 is ignored', () => {
  assert.equal(candleEnd('15minute', ist('2026-11-11T09:15:00')), ist('2026-11-11T09:30:00'))
  assert.equal(candleEnd('15minute', ist('2026-11-11T15:15:00')), ist('2026-11-11T15:30:00'))
  assert.equal(candleEnd('15minute', ist('2026-11-11T15:45:00')), null)
})

test('1-hour and 4-hour bars that start before 09:15 are real', () => {
  assert.equal(candleEnd('1hour', ist('2026-11-11T09:00:00')), ist('2026-11-11T10:00:00'))
  assert.equal(candleEnd('4hour', ist('2026-11-11T08:00:00')), ist('2026-11-11T12:00:00'))
  assert.equal(candleEnd('4hour', ist('2026-11-11T12:00:00')), ist('2026-11-11T15:30:00'))
})

test('nothing is due at 09:15 - the first 15-min bar closes at 09:30', () => {
  assert.equal(latestExpectedBarEnd('15minute', ist('2026-11-11T09:15:00')), ist('2026-11-10T15:30:00'))
  assert.equal(latestExpectedBarEnd('15minute', ist('2026-11-11T09:30:00')), ist('2026-11-11T09:30:00'))
})

test('displayedTime: 15-minute shows the bar start, other timeframes the bar close', async () => {
  const { displayedTime, candleEnd } = await import('../crossoverTimeframes.js')
  const t = (d) => Date.parse(`${d}+05:30`) / 1000
  assert.equal(displayedTime('15minute', t('2026-11-10T09:15:00')), t('2026-11-10T09:15:00'))
  assert.equal(displayedTime('15minute', t('2026-11-10T15:15:00')), t('2026-11-10T15:15:00'))
  assert.equal(displayedTime('1hour', t('2026-11-10T10:00:00')), t('2026-11-10T11:00:00'))
  assert.equal(displayedTime('1day', t('2026-11-10T00:00:00')), candleEnd('1day', t('2026-11-10T00:00:00')))
})

test('candleStartRangeForDisplayRange: 15-minute passes straight through, 1hour is translated', async () => {
  const { candleStartRangeForDisplayRange } = await import('../crossoverTimeframes.js')
  const t = (d) => Date.parse(`${d}+05:30`) / 1000
  assert.deepEqual(candleStartRangeForDisplayRange('15minute', t('2026-11-10T09:30:00'), undefined), { gte: t('2026-11-10T09:30:00'), lte: undefined })
  assert.deepEqual(candleStartRangeForDisplayRange('15minute', null, t('2026-11-10T15:15:00')), { gte: undefined, lte: t('2026-11-10T15:15:00') })
  // 1h: a range starting at 11:00 (close of the 10:00 bar) begins at that bar's start
  assert.equal(candleStartRangeForDisplayRange('1hour', t('2026-11-10T11:00:00'), null).gte, t('2026-11-10T10:00:00'))
})
