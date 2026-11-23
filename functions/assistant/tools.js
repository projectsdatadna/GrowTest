/**
 * The assistant's tools - one registry used by the in-app agent (agent.js) and the
 * MCP server (mcpServer.js). All read-only. Each tool: { name, description,
 * parameters (JSON schema), handler(args, ctx) -> JSON-serialisable result }.
 *
 * ctx: { deps, scope?, sources?, now? }
 *   deps    embed, search, getDocumentTitles, listDocuments, fii (buildFiiDeps()), listScannerSymbols,
 *           fetchQuotes, getGrowwAccessToken, queryGroups
 *   scope   the chat's fixed scope { docType, docIds, from, to } - wins over tool arguments
 *   sources array the run keeps; search_documents appends so [n] citation numbers stay unique across calls
 */

import { hybridRank } from './ranking.js'
import { compareFii, availableDates, pickDocForDate } from '../fii/compare.js'
import { METRICS } from '../fii/metrics.js'
import { computeStopTarget, pickStockPrice } from '../stopTargetCalc.js'
import { TIMEFRAME_ORDER } from '../crossoverTimeframes.js'

const DATE = /^\d{4}-\d{2}-\d{2}$/
const dateProp = { type: 'string', description: 'YYYY-MM-DD (IST calendar date)' }
const SNIPPET_CHARS = 1400

function checkDate(value, name) {
  if (value != null && !DATE.test(String(value))) throw new Error(`${name} must be YYYY-MM-DD`)
}

// A chat's scope overrides what the model asked for, so a scoped chat cannot be widened by a tool call.
function effectiveFilter(args, scope = {}) {
  checkDate(args.dateFrom, 'dateFrom')
  checkDate(args.dateTo, 'dateTo')
  for (const d of args.dates || []) checkDate(d, 'dates[]')
  const filter = { docType: scope.docType || args.docType || undefined, docIds: scope.docIds?.length ? scope.docIds : args.docIds?.length ? args.docIds : undefined }
  if (scope.from || scope.to) Object.assign(filter, { from: scope.from, to: scope.to })
  else if (args.dates?.length) filter.dates = args.dates
  else Object.assign(filter, { from: args.dateFrom, to: args.dateTo })
  return filter
}

const trimSymbol = (s) => String(s || '').trim().toUpperCase().replace(/^NSE[:_]/, '')

export function buildTools() {
  return [
    {
      name: 'search_documents',
      description: 'Semantic search over the uploaded documents (FII/DII reports, PDFs, Excel). Returns numbered passages with title, report date and page - cite them as [n]. Use dates/dateFrom/dateTo to restrict to report dates. Call it again with a different query or date if the first results are not enough.',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'What to look for, in plain words, with any names/numbers' }, dates: { type: 'array', items: dateProp, description: 'Only these exact report dates' }, dateFrom: dateProp, dateTo: dateProp, docType: { type: 'string', enum: ['fii_report', 'general'] }, docIds: { type: 'array', items: { type: 'string' } }, topK: { type: 'integer', minimum: 1, maximum: 10 } }, required: ['query'] },
      async handler(args, { deps, scope, sources = [] }) {
        if (!args.query || typeof args.query !== 'string') throw new Error('query is required')
        const filter = effectiveFilter(args, scope)
        const { vectors } = await deps.embed([args.query])
        const candidates = await deps.search({ vector: vectors[0], ...filter, limit: 30 })
        const ranked = hybridRank(candidates, args.query, { topK: Math.min(args.topK || 6, 10) })
        const titles = new Map((await deps.getDocumentTitles([...new Set(ranked.map((c) => c.docId))])).map((d) => [d.id, d.title]))
        const results = ranked.map((c) => {
          const existing = sources.find((s) => s.docId === c.docId && s.page === c.page && s.text === c.text)
          const source = existing ?? { n: sources.length + 1, docId: c.docId, title: titles.get(c.docId) || 'Untitled', reportDate: c.reportDate ?? null, page: c.page, section: c.section ?? null, text: c.text }
          if (!existing) sources.push(source)
          return { n: source.n, title: source.title, reportDate: source.reportDate, page: source.page, text: c.text.slice(0, SNIPPET_CHARS) }
        })
        return results.length ? { results } : { results: [], note: 'No passages matched. Try list_documents to see which report dates exist.' }
      },
    },
    {
      name: 'list_documents',
      description: 'List uploaded documents (title, report date, type, pages), newest report first. Use it to find which report dates exist before comparing or searching.',
      parameters: { type: 'object', properties: { docType: { type: 'string', enum: ['fii_report', 'general'] }, dateFrom: dateProp, dateTo: dateProp }, required: [] },
      async handler(args, { deps, scope }) {
        const f = effectiveFilter(args, scope)
        const docs = await deps.listDocuments({ docType: f.docType, status: 'ready', from: f.from, to: f.to })
        const filtered = f.docIds ? docs.filter((d) => f.docIds.includes(d.id)) : docs
        return { total: filtered.length, documents: filtered.slice(0, 50).map((d) => ({ docId: d.id, title: d.title, reportDate: d.reportDate, docType: d.docType, pages: d.pageCount, tags: d.tags })) }
      },
    },
    {
      name: 'get_fii_metrics',
      description: `Extracted FII/DII figures of the report for one date (${Object.keys(METRICS).length} standard metrics: cash buy/sell/net, index futures/options, etc.), with whether each figure was verified against the report text.`,
      parameters: { type: 'object', properties: { date: dateProp }, required: ['date'] },
      async handler(args, { deps }) {
        checkDate(args.date, 'date')
        const docs = await deps.fii.listDocuments({ docType: 'fii_report', status: 'ready' })
        const doc = pickDocForDate(docs, args.date)
        if (!doc) return { found: false, availableDates: availableDates(docs).slice(0, 15) }
        let record = await deps.fii.getMetrics(doc.id)
        if (!record || record.status !== 'ready') record = await deps.fii.extract(doc.id).catch(() => null)
        if (!record) return { found: true, title: doc.title, metrics: {}, note: 'Metrics could not be extracted; use search_documents on this date.' }
        return { found: true, title: doc.title, reportDate: doc.reportDate, metrics: Object.fromEntries(Object.entries(record.metrics).map(([k, m]) => [k, { label: METRICS[k].label, value: m.value, unit: m.unit, verified: m.verified }])), warnings: record.warnings }
      },
    },
    {
      name: 'compare_fii',
      description: 'Compare two FII reports: a table of metric changes (computed exactly) plus an AI summary of the positioning shift. compareDate is the earlier report; currentDate defaults to the latest.',
      parameters: { type: 'object', properties: { currentDate: dateProp, compareDate: dateProp }, required: ['compareDate'] },
      async handler(args, { deps }) {
        checkDate(args.currentDate, 'currentDate')
        checkDate(args.compareDate, 'compareDate')
        const r = await compareFii({ currentDate: args.currentDate, compareDate: args.compareDate }, deps.fii)
        if (r.status !== 'SUCCESS') return r
        return { current: r.current, previous: r.previous, deltas: r.deltas.map(({ label, unit, current, previous, delta, deltaPct, verified }) => ({ label, unit, current, previous, delta, deltaPct, verified })), analysis: r.analysis, warnings: r.warnings }
      },
    },
    {
      name: 'calc_stop_target',
      description: 'Suggested Stoploss and Target for a stock from rupee amounts for one lot: stoploss = ₹ / lot size, target = ₹ / lot size, plus each as % of the stock price. Uses the uploaded lot-size sheet and the live price when available.',
      parameters: { type: 'object', properties: { symbol: { type: 'string', description: 'e.g. VEDL' }, stoplossAmount: { type: 'number', description: '₹ risk per lot' }, targetAmount: { type: 'number', description: '₹ profit per lot' }, price: { type: 'number', description: 'Override the stock price' } }, required: ['symbol'] },
      async handler(args, { deps }) {
        const symbol = trimSymbol(args.symbol)
        const entry = (await deps.listScannerSymbols()).find((s) => s.symbol === symbol)
        if (!entry?.lotSize) return { error: `No lot size on file for ${symbol}. Upload the lot-size sheet on the Notifications tab.` }
        let quote = null
        if (!args.price && deps.getGrowwAccessToken) {
          const key = `${entry.exchange}:${entry.symbol}`
          quote = (await deps.fetchQuotes([{ exchange: entry.exchange, symbol: entry.symbol }], await deps.getGrowwAccessToken()))[key] ?? null
        }
        const { price, source } = args.price > 0 ? { price: args.price, source: 'provided' } : pickStockPrice({ quote, sheetPrice: entry.sheetPrice })
        const calc = computeStopTarget({ slAmount: args.stoplossAmount, targetAmount: args.targetAmount, lotSize: entry.lotSize, price })
        return { symbol, lotSize: entry.lotSize, price, priceSource: source, nrmlMargin: entry.nrmlMargin ?? null, ...calc }
      },
    },
    {
      name: 'get_quote',
      description: 'Live price and day change of an NSE cash-market symbol.',
      parameters: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] },
      async handler(args, { deps }) {
        if (!deps.getGrowwAccessToken) return { error: 'Live quotes are not available on this server.' }
        const symbol = trimSymbol(args.symbol)
        const quote = (await deps.fetchQuotes([{ exchange: 'NSE', symbol }], await deps.getGrowwAccessToken()))[`NSE:${symbol}`]
        return quote ? { symbol, ...quote } : { error: `No quote for ${symbol}` }
      },
    },
    {
      name: 'get_notifications',
      description: 'Latest crossover signals the scanner raised (merged per symbol and bar): indicators that crossed, direction, stars (how many indicators agreed), ADX. Filter by symbol, timeframe and direction.',
      parameters: { type: 'object', properties: { symbol: { type: 'string' }, interval: { type: 'string', enum: TIMEFRAME_ORDER, description: 'Timeframe, default 1day' }, direction: { type: 'string', enum: ['bullish', 'bearish'] }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, required: [] },
      async handler(args, { deps }) {
        const interval = args.interval || '1day'
        if (!TIMEFRAME_ORDER.includes(interval)) throw new Error(`interval must be one of ${TIMEFRAME_ORDER.join(', ')}`)
        const filters = { unreadOnly: false }
        if (args.symbol) filters.symbol = trimSymbol(args.symbol)
        if (args.direction) filters.direction = args.direction
        const { items, total } = await deps.queryGroups(interval, filters, { page: 1, pageSize: Math.min(args.limit || 10, 20), group: 'all' })
        return { interval, total, signals: items.map((g) => ({ symbol: g.symbol, candleTimestamp: g.candleTimestamp, stars: g.stars, bias: g.bias, closePrice: g.closePrice, dayChangePct: g.dayChangePct ?? null, adx: g.adx ? { value: g.adx.value, trend: g.adx.trend } : null, indicators: (g.indicators || []).map((i) => `${i.label} ${i.direction}`) })) }
      },
    },
  ]
}

/** Tools as the model sees them, and an executor that never throws (errors go back to the model). */
export function makeToolbox(ctx, tools = buildTools()) {
  const byName = new Map(tools.map((t) => [t.name, t]))
  return {
    definitions: tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
    async run(name, args, { timeoutMs = 25000 } = {}) {
      const tool = byName.get(name)
      if (!tool) return { error: `Unknown tool ${name}` }
      let timer
      try {
        return await Promise.race([tool.handler(args || {}, ctx), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${name} timed out`)), timeoutMs) })])
      } catch (error) {
        return { error: error.message }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
