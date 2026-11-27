import test from 'node:test'
import assert from 'node:assert/strict'
import { crossoverTimestamp, formatCrossoverTime, displayedBarTime } from '../src/components/crossoverFormat.js'

const t = (d) => Date.parse(`${d}+05:30`) / 1000

test('15-minute crossovers are shown at the bar START (09:15 .. 15:15), not the close', () => {
  assert.equal(crossoverTimestamp({ interval: '15minute', candleTimestamp: t('2026-11-10T09:15:00') }), t('2026-11-10T09:15:00'))
  assert.equal(crossoverTimestamp({ interval: '15minute', candleTimestamp: t('2026-11-10T15:15:00') }), t('2026-11-10T15:15:00'))
  assert.match(formatCrossoverTime({ interval: '15minute', candleTimestamp: t('2026-11-10T09:15:00') }), /09:15 IST$/)
})

test('1h / 4h / daily / weekly still show the bar close', () => {
  assert.equal(crossoverTimestamp({ interval: '1hour', candleTimestamp: t('2026-11-10T10:00:00') }), t('2026-11-10T11:00:00'))
  assert.equal(crossoverTimestamp({ interval: '1hour', candleTimestamp: t('2026-11-10T15:00:00') }), t('2026-11-10T15:30:00'))
  assert.equal(crossoverTimestamp({ interval: '4hour', candleTimestamp: t('2026-11-10T08:00:00') }), t('2026-11-10T12:00:00'))
  assert.equal(crossoverTimestamp({ interval: '1day', candleTimestamp: t('2026-11-10T00:00:00') }), t('2026-11-10T15:30:00'))
  assert.equal(crossoverTimestamp({ interval: '1week', candleTimestamp: t('2026-11-09T00:00:00') }), t('2026-11-13T15:30:00'))
})

test('displayedBarTime turns a bar close back into the shown time', () => {
  assert.equal(displayedBarTime('15minute', t('2026-11-10T09:30:00')), t('2026-11-10T09:15:00'))
  assert.equal(displayedBarTime('1hour', t('2026-11-10T11:00:00')), t('2026-11-10T11:00:00'))
  assert.equal(displayedBarTime('15minute', null), 0)
})
