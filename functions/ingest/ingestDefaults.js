/** Real dependencies for ingestDocument (Firestore + Cloud Storage + Azure embeddings). */

import { ingestDocument } from './ingestDocument.js'
import { embedTexts, getEmbeddingConfigFromEnv } from '../aiClient.js'
import { getDocumentRecord, updateDocumentRecord, replaceDocumentChunks } from '../documentsFirestoreClient.js'
import { downloadFile } from '../documentStorage.js'
import { logAiUsage } from '../aiUsageFirestoreClient.js'

export function ingestDocumentWithDefaults(docId, { embeddingConfig = getEmbeddingConfigFromEnv() } = {}) {
  return ingestDocument(docId, {
    getDocument: getDocumentRecord,
    updateDocument: updateDocumentRecord,
    downloadFile,
    replaceChunks: replaceDocumentChunks,
    embed: (texts) => embedTexts(texts, embeddingConfig),
    logUsage: logAiUsage,
    embeddingModel: embeddingConfig.deployment,
  })
}
