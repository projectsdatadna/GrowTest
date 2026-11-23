/** Real dependencies for the assistant (Azure chat + embeddings, Firestore). */

import { chatCompletion, streamChatCompletion, embedTexts, getChatConfigFromEnv, getEmbeddingConfigFromEnv } from '../aiClient.js'
import { searchDocumentChunks, getDocumentRecords, listDocumentRecords } from '../documentsFirestoreClient.js'
import { logAiUsage } from '../aiUsageFirestoreClient.js'
import { buildFiiDeps } from '../fii/deps.js'
import { fetchDayChangeQuotes } from '../growwQuotes.js'
import { listActiveScannerSymbols, queryCrossoverGroupsPage } from '../crossoverScannerFirestoreClient.js'

export function buildAssistantDeps({ chatConfig = getChatConfigFromEnv(), embeddingConfig = getEmbeddingConfigFromEnv(), getGrowwAccessToken } = {}) {
  return {
    chatConfig,
    embed: (texts) => embedTexts(texts, embeddingConfig),
    search: searchDocumentChunks,
    getDocumentTitles: getDocumentRecords,
    listDocuments: listDocumentRecords,
    chat: (messages, options) => chatCompletion(messages, chatConfig, options),
    chatStream: (messages, options) => streamChatCompletion(messages, chatConfig, options),
    // for the agent's tools
    fii: buildFiiDeps({ chatConfig }),
    listScannerSymbols: listActiveScannerSymbols,
    queryGroups: queryCrossoverGroupsPage,
    fetchQuotes: fetchDayChangeQuotes,
    getGrowwAccessToken,
    logUsage: (entry) => logAiUsage({ ...entry, model: entry.feature.startsWith('embed') ? embeddingConfig.deployment : chatConfig.deployment }),
  }
}
