/**
 * Azure OpenAI embeddings for the document / RAG features. Same resource and key
 * as the chat deployment (AZURE_OPENAI_ENDPOINT / _API_KEY); only the deployment
 * differs (AZURE_OPENAI_TEXT_EMBEDDING, text-embedding-3-small = 1536 dimensions).
 * Chat completions stay in aiAnalysisPrompt.js (analyzeWithAI) for now.
 */

import axios from 'axios'

export const EMBEDDING_DIMENSIONS = 1536
const BATCH_SIZE = 100 // inputs per request (Azure allows 2048; smaller keeps retries cheap)
const MAX_ATTEMPTS = 4
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504])

/** Config from process.env (local server / scripts); Cloud Functions build it from secrets. */
export function getEmbeddingConfigFromEnv(env = process.env) {
  return {
    apiKey: env.AZURE_OPENAI_API_KEY,
    endpoint: env.AZURE_OPENAI_ENDPOINT,
    deployment: env.AZURE_OPENAI_TEXT_EMBEDDING,
    apiVersion: env.AZURE_OPENAI_API_VERSION || '2024-10-21',
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function embedBatch(inputs, { apiKey, endpoint, deployment, apiVersion }, http, wait) {
  const url = `${endpoint.replace(/\/+$/, '')}/openai/deployments/${deployment}/embeddings?api-version=${apiVersion}`
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await http.post(url, { input: inputs }, { headers: { 'api-key': apiKey, 'Content-Type': 'application/json' }, timeout: 60000 })
      const data = [...response.data.data].sort((a, b) => a.index - b.index)
      if (data.length !== inputs.length) throw new Error(`Embeddings returned ${data.length} vectors for ${inputs.length} inputs`)
      return { vectors: data.map((d) => d.embedding), tokens: response.data.usage?.total_tokens ?? 0 }
    } catch (error) {
      const status = error.response?.status
      if (attempt >= MAX_ATTEMPTS || !RETRY_STATUSES.has(status)) {
        const detail = error.response?.data?.error?.message || error.message
        throw new Error(`Embedding request failed${status ? ` (${status})` : ''}: ${detail}`)
      }
      const retryAfter = Number(error.response?.headers?.['retry-after'])
      await wait(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** (attempt - 1))
    }
  }
}

/**
 * Embeds `texts` (non-empty strings) in order. Returns { vectors, usage } where
 * vectors[i] is a 1536-number array for texts[i] and usage.total_tokens is the
 * summed token count (for logAiUsage, feature 'embed_chunks'). Retries 429/5xx.
 * `http` / `wait` are injectable for tests.
 */
export async function embedTexts(texts, config, { http = axios, wait = sleep } = {}) {
  if (!config?.apiKey || !config?.endpoint || !config?.deployment) throw new Error('Embedding config incomplete: need apiKey, endpoint and deployment (AZURE_OPENAI_TEXT_EMBEDDING)')
  const cleaned = texts.map((t) => String(t ?? '').replace(/\s+/g, ' ').trim())
  if (cleaned.some((t) => !t)) throw new Error('Cannot embed an empty text')
  const vectors = []
  let tokens = 0
  for (let i = 0; i < cleaned.length; i += BATCH_SIZE) {
    const batch = await embedBatch(cleaned.slice(i, i + BATCH_SIZE), config, http, wait)
    vectors.push(...batch.vectors)
    tokens += batch.tokens
  }
  return { vectors, usage: { prompt_tokens: tokens, completion_tokens: 0, total_tokens: tokens } }
}

// ---------- chat completions (plain / tools / streaming) ----------
// analyzeWithAI (aiAnalysisPrompt.js) stays the JSON-only single-shot helper for the
// option-chain features; these serve the chatbot, the agent and FII compare.

/** Chat config from process.env (local server / scripts); Cloud Functions build it from secrets. */
export function getChatConfigFromEnv(env = process.env) {
  return {
    apiKey: env.AZURE_OPENAI_API_KEY,
    endpoint: env.AZURE_OPENAI_ENDPOINT,
    deployment: env.AZURE_OPENAI_DEPLOYMENT,
    apiVersion: env.AZURE_OPENAI_API_VERSION || '2024-10-21',
  }
}

function chatRequest(messages, config, { tools, toolChoice, temperature = 0.2, maxTokens = 1500, json = false, stream = false } = {}) {
  if (!config?.apiKey || !config?.endpoint || !config?.deployment) throw new Error('Chat config incomplete: need apiKey, endpoint and deployment')
  const body = { messages, temperature, max_tokens: maxTokens }
  if (tools?.length) {
    body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
    if (toolChoice) body.tool_choice = toolChoice
  }
  if (json) body.response_format = { type: 'json_object' }
  if (stream) {
    body.stream = true
    body.stream_options = { include_usage: true }
  }
  return {
    url: `${config.endpoint.replace(/\/+$/, '')}/openai/deployments/${config.deployment}/chat/completions?api-version=${config.apiVersion || '2024-10-21'}`,
    body,
    headers: { 'api-key': config.apiKey, 'Content-Type': 'application/json' },
  }
}

const describeError = (error) => {
  const status = error.response?.status
  return new Error(`Chat request failed${status ? ` (${status})` : ''}: ${error.response?.data?.error?.message || error.message}`)
}

/**
 * One chat completion. Returns { message, toolCalls, usage, finishReason }:
 * message.content is the text (or null when the model asked for tools), toolCalls
 * are [{ id, name, arguments }] with `arguments` already JSON-parsed ({} if the
 * model produced invalid JSON - the agent loop reports that back to the model).
 */
export async function chatCompletion(messages, config, options = {}, { http = axios } = {}) {
  const { url, body, headers } = chatRequest(messages, config, options)
  let response
  try {
    response = await http.post(url, body, { headers, timeout: options.timeout ?? 100000 })
  } catch (error) {
    throw describeError(error)
  }
  const choice = response.data.choices?.[0]
  if (!choice) throw new Error('Chat response had no choices')
  const toolCalls = (choice.message.tool_calls || []).map((c) => ({ id: c.id, name: c.function.name, arguments: safeJson(c.function.arguments) }))
  return { message: choice.message, toolCalls, usage: response.data.usage ?? null, finishReason: choice.finish_reason }
}

function safeJson(text) {
  try {
    const value = JSON.parse(text || '{}')
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

/**
 * Parses an OpenAI-style SSE byte stream into events:
 *   { type: 'delta', text } | { type: 'done', toolCalls, usage, finishReason }
 * Tool-call fragments are accumulated by index and delivered once, in `done`.
 */
export async function* parseChatStream(chunks) {
  let buffer = ''
  const calls = new Map()
  let usage = null
  let finishReason = null
  const handle = function* (line) {
    if (!line.startsWith('data:')) return
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') return
    let json
    try {
      json = JSON.parse(data)
    } catch {
      return
    }
    if (json.usage) usage = json.usage
    const choice = json.choices?.[0]
    if (!choice) return
    if (choice.finish_reason) finishReason = choice.finish_reason
    const delta = choice.delta || {}
    if (delta.content) yield { type: 'delta', text: delta.content }
    for (const call of delta.tool_calls || []) {
      const entry = calls.get(call.index) ?? { id: '', name: '', args: '' }
      if (call.id) entry.id = call.id
      if (call.function?.name) entry.name += call.function.name
      if (call.function?.arguments) entry.args += call.function.arguments
      calls.set(call.index, entry)
    }
  }
  for await (const chunk of chunks) {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk
    const lines = buffer.split('\n')
    buffer = lines.pop()
    for (const line of lines) yield* handle(line.trim())
  }
  if (buffer.trim()) yield* handle(buffer.trim())
  yield { type: 'done', toolCalls: [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => ({ id: c.id, name: c.name, arguments: safeJson(c.args) })), usage, finishReason }
}

/** Streaming chat completion: async generator of parseChatStream events. */
export async function* streamChatCompletion(messages, config, options = {}, { http = axios } = {}) {
  const { url, body, headers } = chatRequest(messages, config, { ...options, stream: true })
  let response
  try {
    response = await http.post(url, body, { headers, timeout: options.timeout ?? 100000, responseType: 'stream' })
  } catch (error) {
    // Error bodies of a streamed request arrive as a stream too.
    if (error.response?.data?.on) {
      const text = await new Promise((resolve) => {
        let out = ''
        error.response.data.on('data', (d) => { out += d })
        error.response.data.on('end', () => resolve(out))
        error.response.data.on('error', () => resolve(out))
      })
      try {
        error.response.data = JSON.parse(text)
      } catch {
        error.response.data = { error: { message: text.slice(0, 200) } }
      }
    }
    throw describeError(error)
  }
  yield* parseChatStream(response.data)
}
