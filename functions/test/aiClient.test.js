import test from 'node:test'
import assert from 'node:assert/strict'
import { embedTexts, getEmbeddingConfigFromEnv } from '../aiClient.js'

const config = { apiKey: 'k', endpoint: 'https://example.openai.azure.com/', deployment: 'emb', apiVersion: '2024-10-21' }
const noWait = async () => {}

// Fake Azure: returns vector [len(text)] per input, shuffled, so ordering is by `index`.
function fakeHttp(failures = []) {
  const calls = []
  return {
    calls,
    post: async (url, body) => {
      calls.push({ url, size: body.input.length })
      const failure = failures.shift()
      if (failure) throw Object.assign(new Error('boom'), { response: { status: failure, data: { error: { message: 'throttled' } }, headers: {} } })
      return { data: { data: body.input.map((t, index) => ({ index, embedding: [t.length] })).reverse(), usage: { total_tokens: body.input.length } } }
    },
  }
}

test('embeds in order, batches of 100, normalises whitespace, sums tokens', async () => {
  const http = fakeHttp()
  const texts = Array.from({ length: 250 }, (_, i) => `t${'x'.repeat(i % 7)}\n  y`)
  const { vectors, usage } = await embedTexts(texts, config, { http, wait: noWait })
  assert.equal(vectors.length, 250)
  assert.deepEqual(http.calls.map((c) => c.size), [100, 100, 50])
  assert.equal(http.calls[0].url, 'https://example.openai.azure.com/openai/deployments/emb/embeddings?api-version=2024-10-21')
  assert.deepEqual(vectors[3], [`t${'x'.repeat(3)} y`.length])
  assert.equal(usage.total_tokens, 250)
})

test('retries 429 then succeeds; gives up on 401 and on repeated 429', async () => {
  const retry = fakeHttp([429, 503])
  assert.equal((await embedTexts(['a'], config, { http: retry, wait: noWait })).vectors.length, 1)
  assert.equal(retry.calls.length, 3)
  await assert.rejects(embedTexts(['a'], config, { http: fakeHttp([401]), wait: noWait }), /\(401\)/)
  await assert.rejects(embedTexts(['a'], config, { http: fakeHttp([429, 429, 429, 429]), wait: noWait }), /\(429\)/)
})

test('rejects empty text and incomplete config before any request', async () => {
  const http = fakeHttp()
  await assert.rejects(embedTexts(['ok', '  '], config, { http, wait: noWait }), /empty/)
  await assert.rejects(embedTexts(['ok'], { ...config, deployment: undefined }, { http }), /config incomplete/)
  assert.equal(http.calls.length, 0)
  assert.equal(getEmbeddingConfigFromEnv({ AZURE_OPENAI_TEXT_EMBEDDING: 'd', AZURE_OPENAI_ENDPOINT: 'e', AZURE_OPENAI_API_KEY: 'k' }).apiVersion, '2024-10-21')
})

import { chatCompletion, parseChatStream } from '../aiClient.js'

const chatConfig = { apiKey: 'k', endpoint: 'https://e.openai.azure.com', deployment: 'chat', apiVersion: '2024-10-21' }

test('chatCompletion: sends tools, parses tool calls (bad JSON args -> {}), returns usage', async () => {
  let sent
  const http = { post: async (url, body) => { sent = { url, body }; return { data: { usage: { total_tokens: 9 }, choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'search_documents', arguments: '{"query":"fii"}' } }, { id: 'c2', function: { name: 'x', arguments: '{oops' } }] } }] } } } }
  const out = await chatCompletion([{ role: 'user', content: 'hi' }], chatConfig, { tools: [{ name: 'search_documents', description: 'd', parameters: { type: 'object', properties: {} } }], json: false }, { http })
  assert.equal(sent.body.tools[0].function.name, 'search_documents')
  assert.match(sent.url, /deployments\/chat\/chat\/completions/)
  assert.deepEqual(out.toolCalls, [{ id: 'c1', name: 'search_documents', arguments: { query: 'fii' } }, { id: 'c2', name: 'x', arguments: {} }])
  assert.equal(out.usage.total_tokens, 9)
  await assert.rejects(chatCompletion([], { ...chatConfig, apiKey: '' }, {}, { http }), /config incomplete/)
  await assert.rejects(chatCompletion([], chatConfig, {}, { http: { post: async () => { throw Object.assign(new Error('x'), { response: { status: 401, data: { error: { message: 'bad key' } } } }) } } }), /\(401\): bad key/)
})

test('parseChatStream: text deltas, split chunks, accumulated tool-call fragments, usage', async () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"search_","arguments":"{\\"q\\":"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"documents","arguments":"\\"fii\\"}"}}]}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    'data: {"choices":[],"usage":{"total_tokens":42}}\n\ndata: [DONE]\n\n',
  ]
  // Split a chunk mid-line to prove buffering works.
  const chunks = [sse[0].slice(0, 20), sse[0].slice(20), sse[1], sse[2], sse[3]]
  const events = []
  for await (const e of parseChatStream(chunks)) events.push(e)
  assert.equal(events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'Hello')
  const done = events.at(-1)
  assert.equal(done.type, 'done')
  assert.deepEqual(done.toolCalls, [{ id: 'c1', name: 'search_documents', arguments: { q: 'fii' } }])
  assert.equal(done.usage.total_tokens, 42)
  assert.equal(done.finishReason, 'tool_calls')
})
