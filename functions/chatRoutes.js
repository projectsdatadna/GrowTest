/**
 * Chat API.
 *   POST /chat                      { conversationId?, message, fileIds? } -> { conversationId, answer, files, ... }
 *   GET  /chat/conversations/:id    the saved messages and files of a conversation (to restore a chat)
 */

import * as defaultConversations from './chatFirestoreClient.js'
import * as defaultFiles from './filesFirestoreClient.js'
import { chatCompletion, getChatConfigFromEnv } from './aiClient.js'
import { logAiUsage } from './aiUsageFirestoreClient.js'
import { runChat, ChatError, MAX_FILES_PER_REQUEST } from './assistant/chatEngine.js'
import { publicFile } from './fileRoutes.js'

export const MAX_MESSAGE_CHARS = 4000
const ID = /^[A-Za-z0-9]{10,40}$/

export function validateChatRequest(body) {
  const { message, conversationId, fileIds } = body || {}
  if (typeof message !== 'string' || !message.trim()) return { error: 'Type a question first' }
  if (message.length > MAX_MESSAGE_CHARS) return { error: `The message is longer than ${MAX_MESSAGE_CHARS} characters` }
  if (conversationId != null && !ID.test(String(conversationId))) return { error: 'Invalid conversation id' }
  if (fileIds != null && (!Array.isArray(fileIds) || fileIds.length > MAX_FILES_PER_REQUEST || !fileIds.every((id) => ID.test(String(id))))) return { error: `Attach up to ${MAX_FILES_PER_REQUEST} files` }
  return { value: { message: message.trim(), conversationId: conversationId ?? null, fileIds: [...new Set(fileIds ?? [])] } }
}

export function registerChatRoutes(app, { conversations = defaultConversations, files = defaultFiles, chat, logUsage } = {}) {
  const config = () => getChatConfigFromEnv()
  const deps = {
    conversations: { create: (c) => conversations.createConversation(c), get: (id) => conversations.getConversation(id), setFiles: (id, ids) => conversations.setConversationFiles(id, ids), listMessages: (id) => conversations.listMessages(id), appendMessages: (id, m) => conversations.appendMessages(id, m) },
    files: { list: () => files.listFiles(), getBytes: (f) => files.getFileBytes(f) },
    chat: chat ?? ((messages, options) => chatCompletion(messages, config(), options)),
    logUsage: logUsage ?? ((entry) => logAiUsage({ ...entry, model: config().deployment })),
  }

  app.post('/chat', async (req, res) => {
    const { error, value } = validateChatRequest(req.body)
    if (error) return res.status(400).json({ error })
    try {
      res.json({ status: 'SUCCESS', ...(await runChat(value, { ...deps, now: new Date() })) })
    } catch (err) {
      const status = err instanceof ChatError ? err.status : /^Chat request failed/.test(err.message) ? 502 : 500
      console.error('Error in /chat:', err.message)
      res.status(status).json({ error: err.message })
    }
  })

  app.get('/chat/conversations/:id', async (req, res) => {
    try {
      if (!ID.test(req.params.id)) return res.status(400).json({ error: 'Invalid conversation id' })
      const conversation = await deps.conversations.get(req.params.id)
      if (!conversation) return res.status(404).json({ error: 'Conversation not found' })
      const [messages, fileDocs] = await Promise.all([deps.conversations.listMessages(conversation.id), files.getFiles(conversation.fileIds)])
      res.json({ status: 'SUCCESS', conversation: { id: conversation.id, title: conversation.title }, messages: messages.map(({ role, content, fileIds, createdAt }) => ({ role, content, fileIds: fileIds ?? [], createdAt })), files: fileDocs.filter((f) => !f.deleted).map(publicFile) })
    } catch (err) {
      console.error('Error loading conversation:', err.message)
      res.status(500).json({ error: err.message })
    }
  })
}
