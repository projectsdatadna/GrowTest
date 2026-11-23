import test from 'node:test'
import assert from 'node:assert/strict'
import { extractDateFilter, mergeScope, findAllDates, istToday } from '../assistant/dateFilter.js'
import { extractCitations, formatSources, buildUserMessage } from '../assistant/prompts.js'
import { hybridRank, tokenize, keywordScore } from '../assistant/ranking.js'

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

test('scope wins over dates in the question; latest only when nothing else', () => {
  const extracted = f('on 14 Nov 2025')
  assert.deepEqual(mergeScope(extracted, { from: '2025-01-01', to: '2025-01-31', docType: 'fii_report' }), { docType: 'fii_report', docIds: null, dates: null, from: '2025-01-01', to: '2025-01-31', latest: false })
  assert.deepEqual(mergeScope(extracted, {}).dates, ['2025-11-14'])
  assert.equal(mergeScope(f('latest report'), {}).latest, true)
  assert.deepEqual(mergeScope(f('x'), { docIds: ['a', 'b'] }).docIds, ['a', 'b'])
})

test('ranking: keyword hits (numbers weigh double) lift a candidate the vector order put low', () => {
  assert.deepEqual(tokenize('FII sold 1,200 crore in the BANKNIFTY'), ['fii', 'sold', '1200', 'crore', 'banknifty'])
  assert.equal(keywordScore(tokenize('1200 crore'), 'net 1,200 crore'), 3)
  const candidates = [
    { id: 'a', text: 'general market commentary about sentiment' },
    { id: 'b', text: 'unrelated table of margins' },
    { id: 'c', text: 'FII index futures net short 1,200 crore on the day' },
  ]
  const ranked = hybridRank(candidates, 'FII index futures 1200 crore', { topK: 2 })
  assert.equal(ranked[0].id, 'c')
  assert.equal(ranked.length, 2)
  assert.equal(hybridRank([], 'q').length, 0)
})

test('citations: only sources that exist and are cited, in first-use order; context is delimited as data', () => {
  const sources = [1, 2, 3].map((n) => ({ n, docId: `d${n}`, title: `T${n}`, reportDate: '2025-11-14', page: n, section: null, text: `text ${n}` }))
  assert.deepEqual(extractCitations('A [3]. B [1][3]. C [2, 9]. D [7].', sources).map((c) => c.n), [3, 1, 2])
  assert.deepEqual(extractCitations('no cites', sources), [])
  assert.match(formatSources(sources), /\[1\] T1 \| report date 2025-11-14 \| page 1\n<<<\ntext 1\n>>>/)
  assert.match(buildUserMessage('What?', sources), /Question: What\?$/)
})

import { ragAnswer, resolveFilter, trimHistory } from '../assistant/rag.js'

const libDocs = [
  { id: 'd1', title: 'FII 14 Nov', reportDate: '2025-11-14', docType: 'fii_report' },
  { id: 'd2', title: 'FII 10 Nov', reportDate: '2025-11-10', docType: 'fii_report' },
]
function ragDeps(over = {}) {
  const calls = { search: [], embed: [], chat: [], usage: [] }
  return {
    calls,
    deps: {
      now: NOW,
      listDocuments: async () => libDocs,
      embed: async (t) => { calls.embed.push(t); return { vectors: [[0.1, 0.2]], usage: { total_tokens: 5 } } },
      search: async (p) => { calls.search.push(p); return [{ id: 'c1', docId: 'd1', page: 2, section: 'Index Futures', reportDate: '2025-11-14', text: 'FII index futures net short 1200 crore' }, { id: 'c2', docId: 'd1', page: 3, reportDate: '2025-11-14', text: 'DII net buy 900 crore' }] },
      getDocumentTitles: async (ids) => libDocs.filter((d) => ids.includes(d.id)),
      chat: async (messages) => { calls.chat.push(messages); return { message: { content: '"FII index futures on 14 Nov 2025"' }, usage: { total_tokens: 3 } } },
      chatStream: async function* (messages) { calls.stream = messages; yield { type: 'delta', text: 'FIIs were net short [1]' }; yield { type: 'delta', text: ' and DIIs bought [2].' }; yield { type: 'done', usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } } },
      logUsage: async (e) => calls.usage.push(e.feature),
      ...over,
    },
  }
}
const collect = async (gen) => { const out = []; for await (const e of gen) out.push(e); return out }

test('rag: date in the question filters the search; answer streams with citations and sources first', async () => {
  const { deps, calls } = ragDeps()
  const events = await collect(ragAnswer({ question: 'What did FIIs do in index futures on 14 Nov 2025?' }, deps))
  assert.deepEqual(calls.search[0].dates, ['2025-11-14'])
  assert.equal(calls.search[0].limit, 30)
  assert.deepEqual(events.map((e) => e.type), ['filter', 'sources', 'delta', 'delta', 'done'])
  const sources = events[1].sources
  assert.equal(sources[0].title, 'FII 14 Nov')
  assert.equal(sources[0].reportDate, '2025-11-14')
  assert.ok(!('text' in sources[0]) && sources[0].snippet)
  assert.match(calls.stream.at(-1).content, /report date 2025-11-14 \| page 2/)
  assert.equal(calls.stream[0].role, 'system')
  const done = events.at(-1)
  assert.deepEqual(done.citations.map((c) => c.n), [1, 2])
  assert.equal(done.usage.total_tokens, 5 + 110)
  assert.deepEqual(calls.usage, ['embed_query', 'chat_answer'])
})

test('rag: follow-up is rewritten to a standalone query before embedding', async () => {
  const { deps, calls } = ragDeps()
  await collect(ragAnswer({ question: 'and the day before?', history: [{ role: 'user', content: 'FII on 14 Nov 2025?' }, { role: 'assistant', content: 'Net short [1]' }] }, deps))
  assert.equal(calls.chat.length, 1)
  assert.deepEqual(calls.embed[0], ['FII index futures on 14 Nov 2025'], 'quotes stripped, rewritten text embedded')
  assert.ok(calls.usage.includes('chat_rewrite'))
})

test('rag: a date with no documents answers from the library without any model call', async () => {
  const { deps, calls } = ragDeps()
  const events = await collect(ragAnswer({ question: 'FII on 5 Nov 2025' }, deps))
  assert.match(events[1].text, /no indexed documents for report date 2025-11-05\. Report dates I do have: 2025-11-14, 2025-11-10\. \(A date without a year/)
  assert.equal(calls.embed.length + calls.search.length + calls.chat.length, 0)
  assert.equal(events.at(-1).type, 'done')
})

test('rag: "latest" resolves to the newest report date; scope docIds skips the library check', async () => {
  const { deps, calls } = ragDeps()
  await collect(ragAnswer({ question: 'summarise the latest report' }, deps))
  assert.deepEqual(calls.search[0].dates, ['2025-11-14'])
  const second = ragDeps({ listDocuments: async () => { throw new Error('should not list') } })
  await collect(ragAnswer({ question: 'what is the net position on 1 Jan 2025?', scope: { docIds: ['d1'] } }, second.deps))
  assert.deepEqual(second.calls.search[0].docIds, ['d1'])
  const none = await resolveFilter('latest', {}, { listDocuments: async () => [], now: NOW })
  assert.match(none.empty, /no indexed documents/)
})

test('rag: nothing relevant found -> honest message, no answer call; history is trimmed', async () => {
  const { deps, calls } = ragDeps({ search: async () => [] })
  const events = await collect(ragAnswer({ question: 'tell me about X' }, deps))
  assert.match(events[1].text, /could not find anything relevant/)
  assert.equal(calls.stream, undefined)
  const long = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(3000) }))
  const trimmed = trimHistory([{ role: 'system', content: 'no' }, ...long])
  assert.equal(trimmed.length, 6)
  assert.equal(trimmed[0].content.length, 1500)
})

import { scoreAnswer, summarize } from '../assistant/evalScoring.js'

test('eval scoring: contains / not-contains (commas ignored), cited dates, date leakage, refusals, errors', () => {
  const cite = (d) => ({ n: 1, reportDate: d })
  const g = { id: 'q', mustContain: ['60,000'], mustNotContain: ['999'], citeDates: ['2025-11-14'], onlyDates: ['2025-11-14'] }
  assert.deepEqual(scoreAnswer(g, { answer: 'Net short 60000 contracts [1]', citations: [cite('2025-11-14')] }), { id: 'q', pass: true, failures: [] })
  const bad = scoreAnswer(g, { answer: 'Net short 999 [1]', citations: [cite('2025-11-10')] })
  assert.equal(bad.pass, false)
  assert.deepEqual(bad.failures, ['missing "60,000"', 'should not contain "999"', 'no citation from 2025-11-14', 'cites a source dated 2025-11-10'])
  assert.equal(scoreAnswer({ id: 'r', expectRefusal: true }, { answer: 'I have no indexed documents for report date 2020-01-01.', citations: [] }).pass, true)
  assert.equal(scoreAnswer({ id: 'r', expectRefusal: true }, { answer: 'FIIs sold 5 crore [1]', citations: [cite('x')] }).pass, false)
  assert.deepEqual(scoreAnswer({ id: 'n' }, { answer: 'An answer with no sources', citations: [] }).failures, ['no citations'])
  assert.deepEqual(scoreAnswer({ id: 'e' }, { error: 'HTTP 500' }).failures, ['error: HTTP 500'])
  assert.deepEqual(summarize([{ pass: true }, { pass: false }, { pass: true }]), { total: 3, passed: 2, failed: 1, rate: 67 })
})
