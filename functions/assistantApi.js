/**
 * Production entry for the file chat: `growtestAssistantApi` = file upload / library (/files), the
 * chat (/chat), the standard question bank (/question-bank) and the saved option chains (/option-chain-history). It is its own function, separate from
 * growtestApi, because a chat turn can send several PDFs to the model and take longer than
 * growtestApi's 120 s / 256 MiB, and a mistake here must not take the dashboard API down.
 *
 * Imports are lazy (first request), so exporting this from index.js costs the other functions nothing
 * at cold start. It uses the same four Azure secrets as growtestApi, exposed as process.env.<NAME>.
 *
 * Deploying (shared project dev-cogniglob - never a bare `--only functions`, see FIREBASE_DEPLOY.md):
 *   firebase deploy --only functions:growtestApi,functions:growtestAssistantApi
 */

import express from 'express'
import cors from 'cors'
import { onRequest } from 'firebase-functions/v2/https'
import { defineSecret } from 'firebase-functions/params'

const SECRETS = ['AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_DEPLOYMENT', 'AZURE_OPENAI_API_VERSION'].map((name) => defineSecret(name))

export async function buildAssistantApp() {
  const [{ registerFileRoutes }, { registerChatRoutes }, { registerQuestionBankRoutes }, { registerOptionChainHistoryRoutes }] = await Promise.all([import('./fileRoutes.js'), import('./chatRoutes.js'), import('./questionBankRoutes.js'), import('./optionChainHistoryRoutes.js')])
  const app = express()
  app.use(cors())
  app.use(express.json({ limit: '1mb' }))
  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'assistant' }))
  registerFileRoutes(app)
  registerChatRoutes(app)
  registerQuestionBankRoutes(app)
  registerOptionChainHistoryRoutes(app)
  app.use((_req, res) => res.status(404).json({ error: 'Endpoint not found' }))
  return app
}

let appPromise
export const growtestAssistantApi = onRequest({ secrets: SECRETS, timeoutSeconds: 300, memory: '1GiB', concurrency: 10 }, async (req, res) => {
  appPromise ??= buildAssistantApp()
  try {
    const app = await appPromise
    app(req, res)
  } catch (error) {
    appPromise = undefined
    console.error('Assistant API failed to start:', error)
    res.status(500).json({ error: 'Assistant API failed to start' })
  }
})
