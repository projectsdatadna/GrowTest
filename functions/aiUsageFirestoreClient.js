/**
 * A single shared usage/cost log for every Azure OpenAI call this app
 * makes, regardless of which feature made it (Greek Analysis, Compare,
 * Watchlist, Historical Chart AI Insight) - deliberately its own collection
 * rather than a field bolted onto each feature's own existing schema
 * (optionChainSnapshots, watchlistAnalyses, ...), since a usage/cost query
 * should only ever need to look in one place. Used by both the deployed
 * Cloud Function (functions/index.js) and the local dev server (root
 * server.js), same relative-import pattern as every other Firestore client
 * in this app.
 */

import admin from 'firebase-admin'
import { getFirestore } from 'firebase-admin/firestore'

const PROJECT_ID = 'dev-cogniglob'
const DATABASE_ID = 'groww-dashboard'

if (admin.apps.length === 0) {
  admin.initializeApp({ projectId: PROJECT_ID })
}

const db = getFirestore(admin.app(), DATABASE_ID)
const AI_USAGE_LOG_COLLECTION = 'aiUsageLog'

/**
 * One doc per Azure OpenAI call. `usage` is analyzeWithAI's own returned
 * `{prompt_tokens, completion_tokens, total_tokens}` (or null if Azure
 * didn't return one, e.g. a failed call that threw before this is reached -
 * callers should only call this after a successful analyzeWithAI resolve).
 * Never throws into the caller's own request flow - a logging failure
 * should not fail the actual AI analysis the user is waiting on.
 */
export async function logAiUsage({ feature, usage, model, metadata }) {
  try {
    await db.collection(AI_USAGE_LOG_COLLECTION).add({
      feature,
      promptTokens: usage?.prompt_tokens ?? null,
      completionTokens: usage?.completion_tokens ?? null,
      totalTokens: usage?.total_tokens ?? null,
      model: model || null,
      metadata: metadata || {},
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    })
  } catch (error) {
    console.error('Failed to log AI usage (non-fatal):', error.message)
  }
}
