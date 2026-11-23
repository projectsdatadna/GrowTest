/**
 * Production entry for the document assistant: uploads, indexing, FII comparison, chat / agent and
 * (optionally) MCP, as ONE dedicated Cloud Function, `growtestAssistantApi`. It is separate from
 * growtestApi because indexing a large PDF and an agent run both outlast growtestApi's
 * 120 s / 256 MiB, and a mistake here must not take the dashboard API down.
 *
 * The heavy modules (PDF parser, MCP SDK, Excel) are imported lazily on the first request, so
 * exporting this from index.js costs the other functions nothing at cold start.
 *
 * Deploying (shared project dev-cogniglob - never a bare `--only functions`, see FIREBASE_DEPLOY.md):
 *   firebase deploy --only functions:growtestApi,functions:growtestAssistantApi
 * Secrets (Secret Manager, shared with growtestApi): AZURE_OPENAI_API_KEY / _ENDPOINT / _DEPLOYMENT /
 * _API_VERSION. The embedding deployment name is plain config (a param below), not a secret.
 * MCP (POST /mcp) stays off until you create the optional secret MCP_AUTH_TOKEN, add it to SECRETS
 * below and redeploy.
 */

import express from 'express'
import cors from 'cors'
import { onRequest } from 'firebase-functions/v2/https'
import { defineSecret, defineString } from 'firebase-functions/params'

// Bound secrets are exposed to the function as process.env.<NAME>, which is what the shared
// modules (aiClient.js getChatConfigFromEnv / getEmbeddingConfigFromEnv) read.
const SECRETS = ['AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_DEPLOYMENT', 'AZURE_OPENAI_API_VERSION'].map((name) => defineSecret(name))
// Name of the text-embedding-3-small deployment on the same Azure OpenAI resource (not a credential).
const EMBEDDING_DEPLOYMENT = defineString('AZURE_OPENAI_TEXT_EMBEDDING', { default: 'grow-text-embedding-3-small' })
// Private bucket for uploaded documents (created with versioning + CORS, see storage.cors.json).
const DOCUMENTS_BUCKET = defineString('DOCUMENTS_BUCKET', { default: 'dev-cogniglob-groww-documents' })

export async function buildAssistantApp() {
  const [{ registerDocumentRoutes }, { registerFiiRoutes }, { registerAssistantRoutes }, { registerMcpRoutes }, { getStoredGrowwAccessToken }] = await Promise.all([
    import('./documentRoutes.js'),
    import('./fiiRoutes.js'),
    import('./assistantRoutes.js'),
    import('./mcpServer.js'),
    import('./firestoreClient.js'),
  ])
  const getGrowwAccessToken = async () => {
    const token = await getStoredGrowwAccessToken()
    if (!token) throw new Error('No Groww access token has been saved yet')
    return token
  }
  const app = express()
  app.use(cors())
  app.use(express.json({ limit: '1mb' }))
  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'assistant' }))
  registerDocumentRoutes(app)
  registerFiiRoutes(app)
  registerAssistantRoutes(app, { getGrowwAccessToken })
  registerMcpRoutes(app, { getGrowwAccessToken }) // no-op unless MCP_AUTH_TOKEN is set
  app.use((_req, res) => res.status(404).json({ error: 'Endpoint not found' }))
  return app
}

let appPromise
export const growtestAssistantApi = onRequest(
  { secrets: SECRETS, timeoutSeconds: 540, memory: '1GiB', concurrency: 20 },
  async (req, res) => {
    process.env.DOCUMENTS_BUCKET ||= DOCUMENTS_BUCKET.value()
    process.env.AZURE_OPENAI_TEXT_EMBEDDING ||= EMBEDDING_DEPLOYMENT.value()
    appPromise ??= buildAssistantApp()
    try {
      const app = await appPromise
      app(req, res)
    } catch (error) {
      appPromise = undefined
      console.error('Assistant API failed to start:', error)
      res.status(500).json({ error: 'Assistant API failed to start' })
    }
  }
)
