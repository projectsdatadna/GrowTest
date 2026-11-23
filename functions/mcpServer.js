/**
 * MCP (Model Context Protocol) server exposing the assistant's read-only tools -
 * search_documents, list_documents, get_fii_metrics, compare_fii, calc_stop_target,
 * get_quote, get_notifications - so Claude Desktop, Claude Code or any MCP client
 * can query the uploaded documents and FII data. The tools are the SAME registry the in-app
 * agent uses (assistant/tools.js); the in-app agent calls them directly, not through MCP.
 *
 *   POST /mcp   Streamable HTTP transport, stateless (one server per request)
 *
 * Requires `Authorization: Bearer <MCP_AUTH_TOKEN>`. If MCP_AUTH_TOKEN is not set the
 * endpoint is not registered at all: it exposes internal documents outside the app, so it
 * must never be open by default.
 */

import crypto from 'node:crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { buildTools, makeToolbox } from './assistant/tools.js'
import { buildAssistantDeps } from './assistant/deps.js'

export const MCP_SERVER_INFO = { name: 'groww-dashboard-assistant', version: '1.0.0' }

export function createMcpServer(deps, tools = buildTools()) {
  const server = new Server(MCP_SERVER_INFO, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name, description, parameters }) => ({ name, description, inputSchema: parameters, annotations: { readOnlyHint: true, openWorldHint: false } })),
  }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params
    // Fresh per call: [n] citation numbers are only meaningful within one search result.
    const box = makeToolbox({ deps, scope: {}, sources: [] }, tools)
    const result = await box.run(name, args)
    return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: Boolean(result?.error) }
  })
  return server
}

const safeEqual = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest()
  const y = crypto.createHash('sha256').update(String(b)).digest()
  return crypto.timingSafeEqual(x, y)
}

/** Registers POST /mcp when a token is configured; returns whether it did. */
export function registerMcpRoutes(app, { token = process.env.MCP_AUTH_TOKEN, deps, getGrowwAccessToken } = {}) {
  if (!token || token.length < 16) return false
  let resolved = deps
  const getDeps = () => (resolved ??= buildAssistantDeps({ getGrowwAccessToken }))

  app.post('/mcp', async (req, res) => {
    const header = req.headers.authorization || ''
    if (!header.startsWith('Bearer ') || !safeEqual(header.slice(7), token)) {
      return res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null })
    }
    const server = createMcpServer(getDeps())
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => {
      transport.close()
      server.close()
    })
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
    } catch (error) {
      console.error('Error handling MCP request:', error.message)
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null })
    }
  })
  const notAllowed = (_req, res) => res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server: use POST)' }, id: null })
  app.get('/mcp', notAllowed)
  app.delete('/mcp', notAllowed)
  return true
}
