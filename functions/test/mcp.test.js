import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { registerMcpRoutes } from '../mcpServer.js'

const TOKEN = 'test-token-0123456789abcdef'
const docs = [{ id: 'd1', title: 'FII 14 Nov', reportDate: '2025-11-14', docType: 'fii_report', pageCount: 2 }]
const deps = {
  embed: async () => ({ vectors: [[1]], usage: {} }),
  search: async () => [{ id: 'c1', docId: 'd1', page: 2, section: null, reportDate: '2025-11-14', text: 'FII net short 1200 crore' }],
  getDocumentTitles: async () => docs,
  listDocuments: async () => docs,
  fii: { listDocuments: async () => docs, getMetrics: async () => ({ status: 'ready', warnings: [], metrics: {} }), extract: async () => null },
  listScannerSymbols: async () => [{ symbol: 'VEDL', exchange: 'NSE', lotSize: 1150, sheetPrice: 237.85 }],
  fetchQuotes: async () => ({}), queryGroups: async () => ({ items: [], total: 0 }),
}
async function start(token) {
  const app = express()
  app.use(express.json())
  const registered = registerMcpRoutes(app, { token, deps })
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)) })
  return { registered, url: new URL(`http://localhost:${server.address().port}/mcp`), close: () => { server.closeAllConnections(); server.close() } }
}

test('mcp: not registered without a (long enough) token', async () => {
  for (const token of [undefined, '', 'short']) {
    const { registered, url, close } = await start(token)
    assert.equal(registered, false)
    assert.equal((await fetch(url, { method: 'POST' })).status, 404)
    close()
  }
})

test('mcp: rejects missing / wrong bearer token', async () => {
  const { url, close } = await start(TOKEN)
  const call = (headers) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
  assert.equal((await call({})).status, 401)
  assert.equal((await call({ authorization: 'Bearer wrong' })).status, 401)
  assert.equal((await fetch(url)).status, 405)
  close()
})

test('mcp: a real MCP client lists the read-only tools and calls them over HTTP', async () => {
  const { url, close } = await start(TOKEN)
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }))
  const { tools } = await client.listTools()
  assert.deepEqual(tools.map((t) => t.name).sort(), ['calc_stop_target', 'compare_fii', 'get_fii_metrics', 'get_notifications', 'get_quote', 'list_documents', 'search_documents'])
  assert.ok(tools.every((t) => t.annotations.readOnlyHint === true && t.inputSchema.type === 'object'))
  const search = await client.callTool({ name: 'search_documents', arguments: { query: 'FII net', dates: ['2025-11-14'] } })
  assert.equal(search.isError, false)
  const body = JSON.parse(search.content[0].text)
  assert.deepEqual([body.results[0].n, body.results[0].title, body.results[0].reportDate], [1, 'FII 14 Nov', '2025-11-14'])
  const calc = JSON.parse((await client.callTool({ name: 'calc_stop_target', arguments: { symbol: 'VEDL', stoplossAmount: 7500, targetAmount: 17000 } })).content[0].text)
  assert.equal(calc.lotSize, 1150)
  assert.equal(calc.priceSource, 'sheet')
  const bad = await client.callTool({ name: 'search_documents', arguments: { query: 'x', dateFrom: 'nope' } })
  assert.equal(bad.isError, true)
  await client.close()
  close()
})
