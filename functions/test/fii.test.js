import test from 'node:test'
import assert from 'node:assert/strict'
import { validateExtraction, numbersInText, valueAppearsIn, extractFiiMetrics, buildExtractionMessages } from '../fii/metrics.js'
import { computeDeltas, compareFii, pickDocForDate, availableDates, COMPARE_VERSION } from '../fii/compare.js'

const REPORT = 'FII cash: gross buy 12,500.40 gross sell 13,700.40 net (1,200.00)\nIndex futures long 150,000 short 210,000\nDII net buy 900.5'

test('numbers: commas, decimals and bracketed negatives are read; matches within rounding', () => {
  const nums = numbersInText(REPORT)
  assert.ok(nums.has(1200) && nums.has(12500.4) && nums.has(150000) && nums.has(900.5))
  assert.ok(valueAppearsIn(-1200, nums), 'sign ignored')
  assert.ok(valueAppearsIn(900.5, nums))
  assert.ok(!valueAppearsIn(777, nums))
})

test('validation: keeps catalog keys, verifies against text, derives net, flags inconsistent net, parses strings', () => {
  const out = validateExtraction({
    as_of_date: '2025-11-14',
    metrics: {
      fii_cash_buy: { value: 12500.4, page: 1 },
      fii_cash_sell: { value: '13,700.40', page: 1 },
      fii_index_futures_long: { value: 150000 },
      fii_index_futures_short: { value: 210000 },
      fii_index_futures_net: { value: -999999 },
      dii_cash_net: { value: 777 },
      made_up_metric: { value: 5 },
      fii_stock_futures_net: { value: 'n/a' },
    },
    other: [{ name: 'Nifty close', value: '24,500', unit: 'pts' }, { name: '', value: 1 }],
  }, REPORT)
  assert.equal(out.metrics.fii_cash_net.value, -1200)
  assert.equal(out.metrics.fii_cash_net.derived, true)
  assert.equal(out.metrics.fii_cash_sell.value, 13700.4)
  assert.equal(out.metrics.fii_cash_buy.verified, true)
  assert.equal(out.metrics.dii_cash_net.verified, false, '777 is not in the text')
  assert.equal(out.metrics.fii_index_futures_net.verified, false, 'net != long - short')
  assert.ok(!('made_up_metric' in out.metrics) && !('fii_stock_futures_net' in out.metrics))
  assert.deepEqual(out.extra, [{ name: 'Nifty close', value: 24500, unit: 'pts', page: null }])
  assert.equal(out.asOfDate, '2025-11-14')
  assert.ok(out.warnings.some((w) => /unknown metric made_up_metric/.test(w)))
  assert.ok(out.warnings.some((w) => /does not equal buy/.test(w)))
})

test('deltas: computed in code, % vs |previous|, null when a side or the base is missing', () => {
  const rows = computeDeltas(
    { fii_cash_net: { value: -1200, verified: true }, dii_cash_net: { value: 900 }, fii_index_futures_long: { value: 100 } },
    { fii_cash_net: { value: -800, verified: true }, dii_cash_net: { value: 0 }, fii_index_futures_short: { value: 5, verified: false } },
  )
  const by = Object.fromEntries(rows.map((r) => [r.key, r]))
  assert.deepEqual([by.fii_cash_net.delta, by.fii_cash_net.deltaPct, by.fii_cash_net.direction], [-400, -50, 'down'])
  assert.deepEqual([by.dii_cash_net.delta, by.dii_cash_net.deltaPct], [900, null])
  assert.deepEqual([by.fii_index_futures_long.delta, by.fii_index_futures_long.previous], [null, null])
  assert.equal(by.fii_index_futures_short.verified, false)
  assert.deepEqual(rows.map((r) => r.key), ['fii_cash_net', 'dii_cash_net', 'fii_index_futures_long', 'fii_index_futures_short'], 'catalog order')
})

test('doc picking: newest upload for a date; available dates newest first', () => {
  const docs = [{ id: 'a', reportDate: '2025-11-10', uploadedAt: '2025-11-11' }, { id: 'b', reportDate: '2025-11-10', uploadedAt: '2025-11-12' }, { id: 'c', reportDate: '2025-11-14', uploadedAt: '2025-11-15' }]
  assert.equal(pickDocForDate(docs, '2025-11-10').id, 'b')
  assert.equal(pickDocForDate(docs, '2025-11-01'), null)
  assert.deepEqual(availableDates(docs), ['2025-11-14', '2025-11-10'])
})

const docs = [
  { id: 'cur', title: 'FII 14 Nov', reportDate: '2025-11-14', uploadedAt: '2025-11-15', processedAt: 'p1', docType: 'fii_report' },
  { id: 'prev', title: 'FII 10 Nov', reportDate: '2025-11-10', uploadedAt: '2025-11-11', processedAt: 'p2', docType: 'fii_report' },
]
function compareDeps(over = {}) {
  const calls = { chat: 0, saved: [], extract: [], usage: [] }
  const metrics = { cur: { status: 'ready', warnings: [], metrics: { fii_cash_net: { value: -1200, verified: true } } }, prev: { status: 'ready', warnings: ['x'], metrics: { fii_cash_net: { value: -800, verified: true } } } }
  return {
    calls,
    deps: {
      listDocuments: async () => docs,
      getMetrics: async (id) => metrics[id] ?? null,
      extract: async (id) => { calls.extract.push(id); return null },
      listChunks: async (id) => [{ page: 1, text: `report text of ${id}` }],
      chat: async (messages) => { calls.chat += 1; calls.messages = messages; return { message: { content: JSON.stringify({ headline: 'FIIs sold more', positioning_shift: { direction: 'more_bearish', explanation: 'e' }, key_changes: [], other_observations: [], caveats: [] }) }, usage: { total_tokens: 500 } } },
      getCached: async () => calls.cache ?? null,
      saveCached: async (id, r) => { calls.saved.push([id, r]); calls.cache = r },
      logUsage: async (e) => calls.usage.push(e.feature),
      now: () => new Date('2026-11-23T00:00:00Z'),
      ...over,
    },
  }
}

test('compare: deltas from code go into the prompt, result cached, second call is served from cache', async () => {
  const { deps, calls } = compareDeps()
  const result = await compareFii({ compareDate: '2025-11-10' }, deps)
  assert.equal(result.status, 'SUCCESS')
  assert.equal(result.current.reportDate, '2025-11-14', 'current defaults to the latest report')
  assert.equal(result.deltas[0].delta, -400)
  assert.match(calls.messages[1].content, /2025-11-10=-800 → 2025-11-14=-1200; change=-400 \(-50%\)/)
  assert.match(calls.messages[1].content, /report text of cur/)
  assert.equal(result.analysis.positioning_shift.direction, 'more_bearish')
  assert.deepEqual(result.warnings, ['2025-11-10: x'])
  assert.equal(result.cached, false)
  assert.deepEqual(calls.usage, ['fii_compare'])
  assert.equal(calls.saved[0][0], 'cur__prev')
  const again = await compareFii({ compareDate: '2025-11-10' }, deps)
  assert.equal(again.cached, true)
  assert.equal(calls.chat, 1)
  await compareFii({ compareDate: '2025-11-10', force: true }, deps)
  assert.equal(calls.chat, 2)
  calls.cache = { ...calls.cache, currentProcessedAt: 'reprocessed' }
  await compareFii({ compareDate: '2025-11-10' }, deps)
  assert.equal(calls.chat, 3, 'a re-indexed document invalidates the cache')
  assert.equal(COMPARE_VERSION, 1)
})

test('compare: missing date suggests the nearest available dates, same date is rejected, failed metrics fall back to text', async () => {
  const { deps } = compareDeps()
  const missing = await compareFii({ compareDate: '2025-11-12' }, deps)
  assert.deepEqual([missing.status, missing.date, missing.available], ['MISSING_DATE', '2025-11-12', ['2025-11-14', '2025-11-10']])
  assert.equal((await compareFii({ currentDate: '2025-11-10', compareDate: '2025-11-10' }, deps)).status, 'INVALID')
  assert.equal((await compareFii({ compareDate: '2025-11-10' }, compareDeps({ listDocuments: async () => [] }).deps)).status, 'MISSING_DATE')
  const noMetrics = compareDeps({ getMetrics: async () => null })
  const result = await compareFii({ compareDate: '2025-11-10' }, noMetrics.deps)
  assert.deepEqual(noMetrics.calls.extract.sort(), ['cur', 'prev'])
  assert.deepEqual(result.deltas, [])
  assert.match(result.warnings[0], /metrics could not be extracted/)
})

test('extraction: reads, verifies and saves; invalid JSON and empty docs are saved as failed', async () => {
  const saved = []
  const base = {
    getDocument: async () => ({ id: 'd', title: 'FII', reportDate: '2025-11-14' }),
    listChunks: async () => [{ page: 1, text: REPORT }],
    saveMetrics: async (id, r) => saved.push(r),
    logUsage: async () => {},
    now: () => new Date('2026-11-23T00:00:00Z'),
  }
  const ok = await extractFiiMetrics('d', { ...base, chat: async (m) => { assert.match(m[1].content, /gross buy 12,500.40/); return { message: { content: JSON.stringify({ as_of_date: '2025-11-13', metrics: { fii_cash_buy: { value: 12500.4 } } }) }, usage: {} } } })
  assert.equal(ok.status, 'ready')
  assert.ok(ok.warnings.some((w) => /as of 2025-11-13/.test(w)))
  await assert.rejects(extractFiiMetrics('d', { ...base, chat: async () => ({ message: { content: 'not json' } }) }), /valid JSON/)
  await assert.rejects(extractFiiMetrics('d', { ...base, listChunks: async () => [], chat: async () => ({}) }), /no indexed text/)
  assert.deepEqual(saved.map((s) => s.status), ['ready', 'failed', 'failed'])
  assert.equal(buildExtractionMessages({ title: 't' }, [{ page: 1, text: 'x'.repeat(100) }, { page: 2, text: 'y'.repeat(100) }], { maxChars: 150 }).sourceText.includes('y'), false)
})

import { signedNumbersInText } from '../fii/metrics.js'

test('sign handling: bracketed negatives restored when the model drops the sign; net = buy - sell sign errors corrected', () => {
  const text = 'FII gross buy 12,000.00 gross sell 12,400.00 net (400.00)\nDII net 500.00 stock futures net (150)'
  const signs = signedNumbersInText(text)
  assert.ok(signs.negative.has(400) && signs.negative.has(150))
  assert.ok(signs.positive.has(500) && signs.positive.has(12000) && !signs.positive.has(400))
  const out = validateExtraction({ metrics: { fii_cash_net: { value: 400 }, dii_cash_net: { value: 500 }, fii_stock_futures_net: { value: 150 } } }, text)
  assert.equal(out.metrics.fii_cash_net.value, -400, 'printed only as (400.00)')
  assert.equal(out.metrics.dii_cash_net.value, 500, 'positive stays positive')
  assert.equal(out.metrics.fii_stock_futures_net.value, -150)
  assert.ok(out.warnings.some((w) => /sign corrected to -400/.test(w)))
  // net opposite to buy - sell but not bracketed in the text -> identity wins
  const id = validateExtraction({ metrics: { fii_cash_buy: { value: 100 }, fii_cash_sell: { value: 160 }, fii_cash_net: { value: 60 } } }, 'buy 100 sell 160 net 60')
  assert.equal(id.metrics.fii_cash_net.value, -60)
  assert.ok(id.warnings.some((w) => /net = buy − sell/.test(w)))
  // a genuinely different net is still just flagged, not rewritten
  const off = validateExtraction({ metrics: { fii_cash_buy: { value: 100 }, fii_cash_sell: { value: 160 }, fii_cash_net: { value: -10 } } }, 'buy 100 sell 160 net -10')
  assert.equal(off.metrics.fii_cash_net.value, -10)
  assert.equal(off.metrics.fii_cash_net.verified, false)
})
