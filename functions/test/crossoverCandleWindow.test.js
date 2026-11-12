import test from 'node:test'
import assert from 'node:assert/strict'
import { fetchSpanDays } from '../crossoverCandleWindow.js'

const DAY = 86400
const now = new Date('2026-11-12T04:00:00Z')
const nowSec = Math.floor(now.getTime() / 1000)

test('fresh window: normal tail', () => {
  assert.equal(fetchSpanDays({ stored: [{ timestamp: nowSec - 3600 }], tailDays: 2, lookbackDays: 14, now }), 2)
})

test('stale window: re-fetch reaches back to the newest stored bar', () => {
  assert.equal(fetchSpanDays({ stored: [{ timestamp: nowSec - 5 * DAY }], tailDays: 2, lookbackDays: 14, now }), 6)
})

test('stale window is capped at lookbackDays', () => {
  assert.equal(fetchSpanDays({ stored: [{ timestamp: nowSec - 40 * DAY }], tailDays: 2, lookbackDays: 14, now }), 14)
})
