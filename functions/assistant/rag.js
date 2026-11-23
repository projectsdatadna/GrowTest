/**
 * Retrieval-augmented answering over the uploaded documents, date-aware.
 *
 *   question -> dates + scope filter -> (rewrite if follow-up) -> embed -> vector search
 *   -> keyword fusion -> top sources -> streamed answer with [n] citations
 *
 * ragAnswer is an async generator of events:
 *   { type: 'filter', filter, query }   what was searched (shown in the UI)
 *   { type: 'sources', sources }        numbered sources, before the answer starts
 *   { type: 'delta', text }             answer text
 *   { type: 'done', citations, usage }  final
 * Every outside effect comes in through `deps`, so it is tested offline.
 */

import { extractDateFilter, mergeScope } from './dateFilter.js'
import { hybridRank } from './ranking.js'
import { RAG_SYSTEM_PROMPT, REWRITE_SYSTEM_PROMPT, buildUserMessage, extractCitations } from './prompts.js'

const HISTORY_MESSAGES = 6
const HISTORY_CHARS = 1500
const CANDIDATES = 30
const TOP_SOURCES = 8

const sumUsage = (...usages) =>
  usages.filter(Boolean).reduce((a, u) => ({ prompt_tokens: a.prompt_tokens + (u.prompt_tokens || 0), completion_tokens: a.completion_tokens + (u.completion_tokens || 0), total_tokens: a.total_tokens + (u.total_tokens || 0) }), { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 })

export function describeFilter(filter) {
  if (filter.dates?.length) return `report date${filter.dates.length > 1 ? 's' : ''} ${filter.dates.join(', ')}`
  if (filter.from || filter.to) return `report dates ${filter.from || '…'} to ${filter.to || '…'}`
  return null
}

const inFilter = (filter, date) => {
  if (!date) return false
  if (filter.dates?.length) return filter.dates.includes(date)
  return (!filter.from || date >= filter.from) && (!filter.to || date <= filter.to)
}

export function trimHistory(history = []) {
  return history
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content)
    .slice(-HISTORY_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content.slice(0, HISTORY_CHARS) }))
}

/**
 * Resolves the filter, checks the library actually has documents for it, and returns
 * { filter } or { filter, empty: <message> } so callers (RAG and the agent's tools) share it.
 */
export async function resolveFilter(question, scope, { listDocuments, now }) {
  const filter = mergeScope(extractDateFilter(question, { now }), scope)
  const needsLibrary = filter.latest || filter.dates || filter.from || filter.to
  if (!needsLibrary || filter.docIds) return { filter }
  const docs = (await listDocuments({ docType: filter.docType || undefined, status: 'ready' })).filter((d) => d.reportDate)
  const available = [...new Set(docs.map((d) => d.reportDate))].sort().reverse()
  if (filter.latest) {
    if (!available.length) return { filter, empty: 'There are no indexed documents with a report date yet - upload one first.' }
    return { filter: { ...filter, latest: false, dates: [available[0]] } }
  }
  if (!docs.some((d) => inFilter(filter, d.reportDate))) {
    const where = describeFilter(filter)
    return { filter, empty: `I have no indexed documents for ${where}.${available.length ? ` Report dates I do have: ${available.slice(0, 10).join(', ')}${available.length > 10 ? ', …' : ''}. (A date without a year means the most recent such date - add the year if you meant another.)` : ' No dated documents are uploaded yet.'}` }
  }
  return { filter }
}

export async function* ragAnswer({ question, history = [], scope = {} }, deps) {
  const { embed, search, getDocumentTitles, listDocuments, chat, chatStream, logUsage, now = new Date() } = deps
  const { filter, empty } = await resolveFilter(question, scope, { listDocuments, now })
  if (empty) {
    yield { type: 'filter', filter, query: question }
    yield { type: 'delta', text: empty }
    yield { type: 'done', citations: [], usage: sumUsage() }
    return
  }

  const past = trimHistory(history)
  let rewriteUsage = null
  let query = question
  if (past.length) {
    const rewritten = await chat([{ role: 'system', content: REWRITE_SYSTEM_PROMPT }, ...past, { role: 'user', content: question }], { maxTokens: 120, temperature: 0 })
    rewriteUsage = rewritten.usage
    query = (rewritten.message.content || '').trim().replace(/^["']|["']$/g, '') || question
    await logUsage?.({ feature: 'chat_rewrite', usage: rewritten.usage })
  }
  yield { type: 'filter', filter, query }

  const { vectors, usage: embedUsage } = await embed([query])
  await logUsage?.({ feature: 'embed_query', usage: embedUsage })
  const candidates = await search({ vector: vectors[0], ...filter, limit: CANDIDATES })
  const ranked = hybridRank(candidates, query, { topK: TOP_SOURCES })
  if (!ranked.length) {
    yield { type: 'delta', text: 'I could not find anything relevant in the uploaded documents.' }
    yield { type: 'done', citations: [], usage: sumUsage(rewriteUsage, embedUsage) }
    return
  }

  const titles = new Map((await getDocumentTitles([...new Set(ranked.map((c) => c.docId))])).map((d) => [d.id, d.title]))
  const sources = ranked.map((c, i) => ({ n: i + 1, docId: c.docId, title: titles.get(c.docId) || 'Untitled', reportDate: c.reportDate ?? null, page: c.page, section: c.section ?? null, text: c.text }))
  yield { type: 'sources', sources: sources.map(({ text, ...rest }) => ({ ...rest, snippet: text.slice(0, 240) })) }

  let answer = ''
  let answerUsage = null
  const messages = [{ role: 'system', content: RAG_SYSTEM_PROMPT }, ...past, { role: 'user', content: buildUserMessage(question, sources) }]
  for await (const event of chatStream(messages, { maxTokens: 1500, temperature: 0.1 })) {
    if (event.type === 'delta') {
      answer += event.text
      yield event
    } else if (event.type === 'done') answerUsage = event.usage
  }
  await logUsage?.({ feature: 'chat_answer', usage: answerUsage, metadata: { sources: sources.length } })
  yield { type: 'done', citations: extractCitations(answer, sources), usage: sumUsage(rewriteUsage, embedUsage, answerUsage) }
}
