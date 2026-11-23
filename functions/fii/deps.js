/** Real dependencies for FII extraction / comparison. */

import { chatCompletion, getChatConfigFromEnv } from '../aiClient.js'
import { getDocumentRecord, listDocumentRecords, listDocumentChunks } from '../documentsFirestoreClient.js'
import { logAiUsage } from '../aiUsageFirestoreClient.js'
import { getFiiMetrics, saveFiiMetrics, getFiiComparison, saveFiiComparison } from './firestore.js'
import { extractFiiMetrics } from './metrics.js'

export function buildFiiDeps({ chatConfig = getChatConfigFromEnv() } = {}) {
  const deps = {
    getDocument: getDocumentRecord,
    listDocuments: listDocumentRecords,
    listChunks: listDocumentChunks,
    chat: (messages, options) => chatCompletion(messages, chatConfig, options),
    getMetrics: getFiiMetrics,
    saveMetrics: saveFiiMetrics,
    getCached: getFiiComparison,
    saveCached: saveFiiComparison,
    logUsage: (entry) => logAiUsage({ ...entry, model: chatConfig.deployment }),
  }
  deps.extract = (docId) => extractFiiMetrics(docId, deps)
  return deps
}
