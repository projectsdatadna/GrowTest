/**
 * Chatbot API.
 *   POST   /chat                       streams the answer as server-sent events
 *   GET    /chat/threads               saved conversations
 *   GET    /chat/threads/:id/messages  one conversation
 *   DELETE /chat/threads/:id
 *
 * POST /chat body: { threadId?, message, mode?: 'rag' | 'agent', scope?: { docType, docIds, from, to } }
 * Events (event: <name>, data: JSON): thread, filter, sources, tool, delta, done, error.
 * `engines.rag` / `engines.agent` are async generators ({question, history, scope}, deps) -> events.
 */

import * as defaultStore from './chatFirestoreClient.js'
import { ragAnswer } from './assistant/rag.js'
import { agentAnswer } from './assistant/agent.js'
import { buildAssistantDeps } from './assistant/deps.js'

export const MAX_MESSAGE_CHARS = 4000
const DATE = /^\d{4}-\d{2}-\d{2}$/
const ID = /^[A-Za-z0-9]{10,40}$/

export function validateChatRequest(body) {
  const { message, threadId, mode = 'rag', scope } = body || {}
  if (typeof message !== 'string' || !message.trim()) return { error: 'message is required' }
  if (message.length > MAX_MESSAGE_CHARS) return { error: `message is longer than ${MAX_MESSAGE_CHARS} characters` }
  if (threadId != null && !ID.test(String(threadId))) return { error: 'invalid threadId' }
  if (!['rag', 'agent'].includes(mode)) return { error: "mode must be 'rag' or 'agent'" }
  const clean = {}
  if (scope != null) {
    if (typeof scope !== 'object') return { error: 'scope must be an object' }
    if (scope.docType) {
      if (!['fii_report', 'general'].includes(scope.docType)) return { error: 'scope.docType must be fii_report or general' }
      clean.docType = scope.docType
    }
    if (scope.docIds != null) {
      if (!Array.isArray(scope.docIds) || scope.docIds.length > 30 || !scope.docIds.every((id) => ID.test(String(id)))) return { error: 'scope.docIds must be up to 30 document ids' }
      clean.docIds = scope.docIds
    }
    for (const key of ['from', 'to']) {
      if (scope[key]) {
        if (!DATE.test(scope[key])) return { error: `scope.${key} must be YYYY-MM-DD` }
        clean[key] = scope[key]
      }
    }
  }
  return { value: { message: message.trim(), threadId: threadId ?? null, mode, scope: clean } }
}

export function registerAssistantRoutes(app, { store = defaultStore, engines, deps, getGrowwAccessToken } = {}) {
  let resolvedDeps = deps
  const getDeps = () => (resolvedDeps ??= buildAssistantDeps({ getGrowwAccessToken }))
  const getEngines = () => engines ?? { rag: ragAnswer, agent: agentAnswer }

  const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

  app.post('/chat', async (req, res) => {
    const { error, value } = validateChatRequest(req.body)
    if (error) return res.status(400).json({ error })
    const engine = getEngines()[value.mode]
    if (!engine) return res.status(501).json({ error: `Mode '${value.mode}' is not available on this server` })

    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
    let closed = false
    res.on('close', () => { closed = true })
    try {
      let threadId = value.threadId
      let history = []
      if (threadId) {
        if (!(await store.getThread(threadId))) {
          send(res, 'error', { error: 'Conversation not found' })
          return res.end()
        }
        history = [...(await store.listMessages(threadId))] // a copy: the current question is stored right after
      } else {
        threadId = await store.createThread({ title: value.message.slice(0, 60), scope: value.scope, mode: value.mode })
      }
      send(res, 'thread', { threadId })
      await store.appendMessage(threadId, { role: 'user', content: value.message })

      let answer = ''
      let sources = []
      const toolCalls = []
      let filter = null
      let final = null
      for await (const event of engine({ question: value.message, history, scope: value.scope }, getDeps())) {
        if (closed) break
        if (event.type === 'delta') answer += event.text
        else if (event.type === 'sources') sources = event.sources
        else if (event.type === 'filter') filter = event.filter
        else if (event.type === 'reset') answer = ''
        else if (event.type === 'tool') {
          if (event.status === 'done') toolCalls.push(event)
        }
        else if (event.type === 'done') final = event
        if (event.type !== 'done') send(res, event.type, event)
      }
      if (final || answer) {
        const messageId = await store.appendMessage(threadId, { role: 'assistant', content: answer, citations: final?.citations ?? [], sources, toolCalls, filter, usage: final?.usage ?? null, mode: value.mode })
        if (!closed) send(res, 'done', { ...final, messageId, threadId })
      }
    } catch (err) {
      console.error('Error in /chat:', err.message)
      if (!closed) send(res, 'error', { error: err.message })
    }
    res.end()
  })

  const guard = (handler) => async (req, res) => {
    try {
      await handler(req, res)
    } catch (err) {
      console.error(`Error in ${req.method} ${req.path}:`, err.message)
      res.status(500).json({ error: err.message })
    }
  }
  const withThread = (handler) => guard(async (req, res) => {
    if (!ID.test(req.params.id)) return res.status(400).json({ error: 'Invalid conversation id' })
    const thread = await store.getThread(req.params.id)
    if (!thread) return res.status(404).json({ error: 'Conversation not found' })
    await handler(req, res, thread)
  })

  app.get('/chat/threads', guard(async (_req, res) => res.json({ status: 'SUCCESS', threads: await store.listThreads() })))
  app.get('/chat/threads/:id/messages', withThread(async (_req, res, thread) => res.json({ status: 'SUCCESS', thread, messages: await store.listMessages(thread.id) })))
  app.delete('/chat/threads/:id', withThread(async (_req, res, thread) => {
    await store.deleteThread(thread.id)
    res.json({ status: 'SUCCESS' })
  }))
}
