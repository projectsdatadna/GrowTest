import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { registerAssistantRoutes, validateChatRequest } from '../assistantRoutes.js'

function memoryStore() {
  const threads = new Map()
  let n = 0
  return {
    threads,
    createThread: async (t) => { const id = `thread${String(++n).padStart(8, '0')}`; threads.set(id, { id, ...t, messages: [] }); return id },
    getThread: async (id) => threads.get(id) ?? null,
    appendMessage: async (id, m) => { threads.get(id).messages.push(m); return `msg${threads.get(id).messages.length}` },
    listMessages: async (id) => threads.get(id).messages,
    listThreads: async () => [...threads.values()],
    deleteThread: async (id) => threads.delete(id),
  }
}

async function start(engine, store = memoryStore()) {
  const app = express()
  app.use(express.json())
  registerAssistantRoutes(app, { store, engines: { rag: engine }, deps: {} })
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)) })
  return { store, base: `http://localhost:${server.address().port}`, close: () => { server.closeAllConnections(); server.close() } }
}
const parseSse = (text) => text.trim().split('\n\n').map((block) => { const [e, d] = block.split('\n'); return [e.slice(7), JSON.parse(d.slice(6))] })
const post = (base, body) => fetch(`${base}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

test('chat request validation', () => {
  assert.match(validateChatRequest({}).error, /message is required/)
  assert.match(validateChatRequest({ message: 'x'.repeat(4001) }).error, /longer/)
  assert.match(validateChatRequest({ message: 'x', mode: 'zzz' }).error, /mode/)
  assert.match(validateChatRequest({ message: 'x', scope: { from: '14-11-2025' } }).error, /YYYY-MM-DD/)
  assert.match(validateChatRequest({ message: 'x', scope: { docIds: ['bad id'] } }).error, /docIds/)
  assert.deepEqual(validateChatRequest({ message: ' hi ', scope: { docType: 'fii_report', from: '2025-11-01', junk: 1 } }).value, { message: 'hi', threadId: null, mode: 'rag', scope: { docType: 'fii_report', from: '2025-11-01' } })
})

test('POST /chat streams events, creates a thread, stores both messages with citations', async () => {
  const seen = []
  const engine = async function* (input) {
    seen.push(input)
    yield { type: 'filter', filter: { dates: ['2025-11-14'] }, query: input.question }
    yield { type: 'sources', sources: [{ n: 1, title: 'T' }] }
    yield { type: 'delta', text: 'Net ' }
    yield { type: 'delta', text: 'short [1]' }
    yield { type: 'done', citations: [{ n: 1 }], usage: { total_tokens: 7 } }
  }
  const { base, store, close } = await start(engine)
  const res = await post(base, { message: 'FII on 14 Nov 2025?', scope: { docType: 'fii_report' } })
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8')
  const events = parseSse(await res.text())
  assert.deepEqual(events.map(([e]) => e), ['thread', 'filter', 'sources', 'delta', 'delta', 'done'])
  const threadId = events[0][1].threadId
  assert.equal(events.at(-1)[1].threadId, threadId)
  assert.deepEqual(seen[0].scope, { docType: 'fii_report' })
  const [user, assistant] = store.threads.get(threadId).messages
  assert.equal(user.content, 'FII on 14 Nov 2025?')
  assert.equal(assistant.content, 'Net short [1]')
  assert.deepEqual(assistant.citations, [{ n: 1 }])

  // follow-up in the same thread gets the history
  await (await post(base, { threadId, message: 'and before?' })).text()
  assert.equal(seen[1].history.length, 2)
  assert.equal(store.threads.get(threadId).messages.length, 4)
  close()
})

test('POST /chat: bad input is a 400, unknown thread and engine failures are error events, unknown mode 501', async () => {
  const { base, close } = await start(async function* () { throw new Error('azure down') })
  assert.equal((await post(base, { message: '' })).status, 400)
  const missing = parseSse(await (await post(base, { threadId: 'doesnotexist1', message: 'x' })).text())
  assert.deepEqual(missing[0], ['error', { error: 'Conversation not found' }])
  const failed = parseSse(await (await post(base, { message: 'x' })).text())
  assert.equal(failed.at(-1)[0], 'error')
  assert.match(failed.at(-1)[1].error, /azure down/)
  assert.equal((await post(base, { message: 'x', mode: 'agent' })).status, 501)
  close()
})

test('threads: list, read, delete, and validation of ids', async () => {
  const { base, store, close } = await start(async function* () { yield { type: 'delta', text: 'ok' }; yield { type: 'done', citations: [], usage: null } })
  const events = parseSse(await (await post(base, { message: 'hello' })).text())
  const id = events[0][1].threadId
  assert.equal((await (await fetch(`${base}/chat/threads`)).json()).threads.length, 1)
  const read = await (await fetch(`${base}/chat/threads/${id}/messages`)).json()
  assert.equal(read.messages.length, 2)
  assert.equal((await fetch(`${base}/chat/threads/bad!/messages`)).status, 400)
  assert.equal((await fetch(`${base}/chat/threads/doesnotexist1/messages`)).status, 404)
  assert.equal((await fetch(`${base}/chat/threads/${id}`, { method: 'DELETE' })).status, 200)
  assert.equal(store.threads.size, 0)
  close()
})

import { createSseParser } from '../../src/services/sse.js'

test('browser SSE parser: events split across chunks, CRLF, multi-line data, malformed skipped', () => {
  const seen = []
  const parser = createSseParser((e, d) => seen.push([e, d]))
  parser.feed('event: thread\ndata: {"threadId":"a"}\n\nevent: del')
  parser.feed('ta\r\ndata: {"text":"Hel"}\r\n\r\nevent: bad\ndata: {oops\n\n')
  parser.feed('event: done\ndata: {"a":\ndata: 1}\n\nevent: tail\ndata: {"x":1}')
  assert.deepEqual(seen, [['thread', { threadId: 'a' }], ['delta', { text: 'Hel' }], ['done', { a: 1 }]])
  parser.end()
  assert.deepEqual(seen.at(-1), ['tail', { x: 1 }])
})
