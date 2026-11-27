import test from 'node:test'
import assert from 'node:assert/strict'
import { sameItems, sameQuote, mergeQuotes, staleKeys, mergeFeedItems } from '../src/components/liveRefresh.js'

test('sameItems compares content, not identity', () => {
  assert.equal(sameItems([{ id: 1, read: false }], [{ id: 1, read: false }]), true)
  assert.equal(sameItems([{ id: 1, read: false }], [{ id: 1, read: true }]), false)
  assert.equal(sameItems([{ id: 1 }], [{ id: 1 }, { id: 2 }]), false)
})

test('mergeQuotes returns the same object when nothing changed', () => {
  const q = { dayChange: 1, dayChangePct: 0.5, lastPrice: 10, prevClose: 9 }
  const current = { 'NSE:A': q, 'NSE:B': null }
  assert.equal(mergeQuotes(current, { 'NSE:A': { ...q }, 'NSE:B': null }), current)
  const next = mergeQuotes(current, { 'NSE:A': { ...q, dayChange: 2 }, 'NSE:C': q })
  assert.notEqual(next, current)
  assert.equal(next['NSE:A'].dayChange, 2)
  assert.equal(next['NSE:C'], q)
  assert.equal(current['NSE:A'].dayChange, 1) // not mutated
})

test('sameQuote handles null', () => {
  assert.equal(sameQuote(null, undefined), true)
  assert.equal(sameQuote(null, { dayChange: 1 }), false)
})

test('staleKeys: never fetched or older than the window', () => {
  const last = new Map([['A', 1000], ['B', 59000]])
  assert.deepEqual(staleKeys(['A', 'B', 'C'], last, 61000, 60000), ['A', 'C'])
})

test('mergeFeedItems: empty or already-known polls change nothing', () => {
  const existing = [{ id: 'a', read: false }, { id: 'b', read: true }]
  assert.equal(mergeFeedItems(existing, []).items, existing)
  const same = mergeFeedItems(existing, [{ id: 'a', read: false }, { id: 'b', read: false }])
  assert.equal(same.changed, false)
  assert.equal(same.items, existing)
})

test('mergeFeedItems: new ids and read-elsewhere items are changes', () => {
  const existing = [{ id: 'a', read: false }]
  const added = mergeFeedItems(existing, [{ id: 'c', read: false }])
  assert.equal(added.changed, true)
  assert.equal(added.items.length, 2)
  const readElsewhere = mergeFeedItems(existing, [{ id: 'a', read: true }])
  assert.equal(readElsewhere.changed, true)
  assert.equal(readElsewhere.items[0].read, true)
})
