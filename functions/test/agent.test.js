import test from 'node:test'
import assert from 'node:assert/strict'
import { agentAnswer, agentSystemPrompt, AGENT_MAX_STEPS } from '../assistant/agent.js'
import { buildTools, makeToolbox } from '../assistant/tools.js'

const NOW = new Date('2026-11-23T04:00:00Z')
const collect = async (gen) => { const out = []; for await (const e of gen) out.push(e); return out }

// A scripted model: each step is [text, toolCalls].
function scripted(steps) {
  const seen = []
  return {
    seen,
    chatStream: async function* (messages, options) {
      seen.push({ messages: structuredClone(messages), tools: options.tools?.map((t) => t.name) })
      const [text = '', toolCalls = []] = steps[seen.length - 1] ?? ['(out of script)', []]
      if (text) yield { type: 'delta', text }
      yield { type: 'done', toolCalls, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
    },
  }
}
const libDocs = [{ id: 'd1', title: 'FII 14 Nov', reportDate: '2025-11-14', docType: 'fii_report', pageCount: 3 }]
function toolDeps(model, over = {}) {
  const calls = { search: [], usage: [] }
  return {
    calls,
    deps: {
      now: NOW,
      chatStream: model.chatStream,
      logUsage: async (e) => calls.usage.push(e.feature),
      embed: async () => ({ vectors: [[1, 2]], usage: {} }),
      search: async (p) => { calls.search.push(p); return [{ id: 'c1', docId: 'd1', page: 2, section: 'Index', reportDate: '2025-11-14', text: 'FII index futures net short 1200 crore' }] },
      getDocumentTitles: async () => libDocs,
      listDocuments: async () => libDocs,
      fii: { listDocuments: async () => libDocs, getMetrics: async () => ({ status: 'ready', warnings: [], metrics: { fii_cash_net: { value: -1200, unit: '₹ cr', verified: true } } }), extract: async () => null },
      listScannerSymbols: async () => [{ symbol: 'VEDL', exchange: 'NSE', lotSize: 1150, sheetPrice: 237.85, nrmlMargin: 62266 }],
      fetchQuotes: async () => ({ 'NSE:VEDL': { lastPrice: 250, dayChange: 2, dayChangePct: 0.8, prevClose: 248 } }),
      getGrowwAccessToken: async () => 'tok',
      queryGroups: async () => ({ items: [{ symbol: 'VEDL', candleTimestamp: 't', stars: 3, bias: 'bullish', closePrice: 250, indicators: [{ label: 'MACD', direction: 'bullish' }] }], total: 1 }),
      ...over,
    },
  }
}

test('agent: tool round then streamed answer; citations map to the search results; trace events in order', async () => {
  const model = scripted([
    ['', [{ id: 'c1', name: 'search_documents', arguments: { query: 'FII index futures', dates: ['2025-11-14'] } }]],
    ['FIIs were net short [1] on 14 Nov 2025.', []],
  ])
  const { deps, calls } = toolDeps(model)
  const events = await collect(agentAnswer({ question: 'What did FIIs do on 14 Nov 2025?' }, deps))
  assert.deepEqual(events.map((e) => e.type + (e.status ? `:${e.status}` : '')), ['tool:running', 'tool:done', 'sources', 'delta', 'done'])
  assert.deepEqual(calls.search[0].dates, ['2025-11-14'])
  assert.equal(events[1].summary, '1 passage')
  assert.deepEqual(events.at(-1).citations.map((c) => [c.n, c.title, c.page]), [[1, 'FII 14 Nov', 2]])
  assert.equal(events.at(-1).usage.total_tokens, 30)
  assert.equal(events.at(-1).steps, 1)
  // the model saw the tool result as a tool message, and the date hint in its system prompt
  const second = model.seen[1].messages
  assert.equal(second.at(-1).role, 'tool')
  assert.match(second.at(-1).content, /FII index futures net short 1200 crore/)
  assert.match(model.seen[0].messages[0].content, /Dates detected in the question: report date 2025-11-14/)
  assert.deepEqual(calls.usage, ['chat_agent_step', 'chat_agent_step'])
})

test('agent: scope overrides tool arguments; text before a tool call is reset; duplicate calls refused', async () => {
  const model = scripted([
    ['Let me look.', [{ id: 'a', name: 'search_documents', arguments: { query: 'x', docType: 'general', dateFrom: '2020-01-01' } }]],
    ['', [{ id: 'b', name: 'search_documents', arguments: { query: 'x', docType: 'general', dateFrom: '2020-01-01' } }]],
    ['Done [1].', []],
  ])
  const { deps, calls } = toolDeps(model)
  const events = await collect(agentAnswer({ question: 'x', scope: { docType: 'fii_report', from: '2025-11-01', to: '2025-11-30' } }, deps))
  assert.equal(calls.search[0].docType, 'fii_report')
  assert.equal(calls.search[0].from, '2025-11-01')
  assert.equal(calls.search.length, 1, 'duplicate not executed')
  assert.ok(events.some((e) => e.type === 'reset'))
  const dup = events.filter((e) => e.type === 'tool' && e.status === 'done')[1]
  assert.equal(dup.ok, false)
  assert.match(model.seen[0].messages[0].content, /restricted to/)
})

test('agent: step cap forces a final answer without tools', async () => {
  const loop = Array.from({ length: 10 }, (_, i) => ['', [{ id: `c${i}`, name: 'list_documents', arguments: { dateFrom: `2025-11-0${i}` } }]])
  const model = scripted([...loop.slice(0, AGENT_MAX_STEPS), ['Best effort answer.', []]])
  const { deps } = toolDeps(model)
  const events = await collect(agentAnswer({ question: 'loop forever' }, deps))
  assert.equal(model.seen.length, AGENT_MAX_STEPS + 1)
  assert.equal(model.seen.at(-1).tools, undefined)
  assert.match(model.seen.at(-1).messages.at(-1).content, /Answer now/)
  assert.equal(events.at(-1).steps, AGENT_MAX_STEPS)
  const budget = scripted([['', [{ id: 'z', name: 'list_documents', arguments: {} }]], ['Over budget answer.', []]])
  const b = toolDeps(budget)
  await collect(agentAnswer({ question: 'q' }, { ...b.deps, tokenBudget: 10 }))
  assert.equal(budget.seen[1].tools, undefined, 'token budget exhausted -> no more tools')
})

test('tools: calc_stop_target uses sheet lot size and live price; matches the sheet formula', async () => {
  const { deps } = toolDeps(scripted([]))
  const box = makeToolbox({ deps, scope: {}, sources: [] })
  const r = await box.run('calc_stop_target', { symbol: 'nse:vedl', stoplossAmount: 7500, targetAmount: 17000 })
  assert.equal(r.lotSize, 1150)
  assert.equal(r.priceSource, 'live')
  assert.equal(r.price, 250)
  assert.ok(Math.abs(r.stoploss - 7500 / 1150) < 1e-9)
  assert.ok(Math.abs(r.targetPct - (17000 / 1150 / 250) * 100) < 1e-9)
  assert.equal(r.nrmlMargin, 62266)
  assert.match((await box.run('calc_stop_target', { symbol: 'UNKNOWN', stoplossAmount: 1 })).error, /No lot size/)
  const offline = makeToolbox({ deps: { ...deps, getGrowwAccessToken: undefined }, scope: {}, sources: [] })
  assert.equal((await offline.run('calc_stop_target', { symbol: 'VEDL', stoplossAmount: 7500 })).priceSource, 'sheet')
})

test('tools: fii metrics, list, quote, notifications, bad input and unknown tools return errors instead of throwing', async () => {
  const { deps } = toolDeps(scripted([]))
  const box = makeToolbox({ deps, scope: {}, sources: [] })
  const m = await box.run('get_fii_metrics', { date: '2025-11-14' })
  assert.equal(m.metrics.fii_cash_net.value, -1200)
  assert.deepEqual((await box.run('get_fii_metrics', { date: '2025-11-01' })).availableDates, ['2025-11-14'])
  assert.equal((await box.run('list_documents', {})).total, 1)
  assert.equal((await box.run('get_quote', { symbol: 'VEDL' })).lastPrice, 250)
  assert.equal((await box.run('get_notifications', { symbol: 'VEDL' })).signals[0].indicators[0], 'MACD bullish')
  assert.match((await box.run('get_notifications', { interval: 'nope' })).error, /interval must be/)
  assert.match((await box.run('search_documents', { query: 'x', dateFrom: '14-11-2025' })).error, /YYYY-MM-DD/)
  assert.match((await box.run('no_such_tool', {})).error, /Unknown tool/)
  const slow = makeToolbox({ deps, scope: {}, sources: [] }, [{ name: 'slow', description: '', parameters: {}, handler: () => new Promise(() => {}) }])
  assert.match((await slow.run('slow', {}, { timeoutMs: 20 })).error, /timed out/)
  assert.equal(buildTools().length, 7)
  assert.match(agentSystemPrompt({ now: NOW, scope: {}, hint: null }), /Today's date is 2026-11-23/)
})
