/**
 * Turns an uploaded file into searchable chunks: download -> parse (PDF / xlsx /
 * csv) -> chunk -> embed -> store, then marks the document ready. Every outside
 * effect is injected (deps) so the flow is tested offline; ingestDocumentWithDefaults
 * wires the real Firestore / Storage / Azure implementations.
 */

import { parsePdf } from './parsePdf.js'
import { parseXlsx, parseCsvBuffer } from './parseSheet.js'
import { chunkPages, embeddingText } from './chunker.js'
import { detectReportDate } from './reportDate.js'

export const PARSER_VERSION = 1
export const MAX_CHUNKS = 3000

export class IngestError extends Error {}

async function parse(extension, buffer) {
  if (extension === 'pdf') return parsePdf(buffer)
  if (extension === 'xlsx') return parseXlsx(buffer)
  if (extension === 'csv') return parseCsvBuffer(buffer)
  throw new IngestError(`Unsupported file type .${extension}`)
}

export async function ingestDocument(docId, { getDocument, updateDocument, downloadFile, replaceChunks, embed, logUsage, embeddingModel, now = () => new Date() }) {
  const doc = await getDocument(docId)
  if (!doc || doc.deleted) throw new IngestError('Document not found')
  await updateDocument(docId, { status: 'processing', error: null })
  try {
    const parsed = await parse(doc.extension, await downloadFile(doc.storagePath))
    if (parsed.needsOcr) throw new IngestError('This PDF has no text layer (scanned images). Upload a text-based PDF or an Excel/CSV version; OCR is not enabled.')
    if (parsed.pages.length === 0) throw new IngestError('No readable text was found in the file')

    let { reportDate, reportDateSource } = doc
    if (!reportDate) {
      const found = detectReportDate({ fileName: doc.fileName, text: parsed.pages.slice(0, 2).map((p) => p.text).join('\n') })
      if (found) ({ date: reportDate, source: reportDateSource } = found)
    }

    const chunks = chunkPages(parsed.pages)
    if (chunks.length > MAX_CHUNKS) throw new IngestError(`File is too large to index (${chunks.length} chunks, limit ${MAX_CHUNKS})`)
    const { vectors, usage } = await embed(chunks.map((c) => embeddingText({ title: doc.title, reportDate, page: c.page, section: c.section }, c.text)))
    await replaceChunks(docId, chunks.map((c, i) => ({ ...c, embedding: vectors[i], reportDate: reportDate ?? null, docType: doc.docType })))
    await logUsage({ feature: 'embed_chunks', usage, model: embeddingModel, metadata: { docId, chunks: chunks.length } })

    const summary = { status: 'ready', pageCount: parsed.pageCount, chunkCount: chunks.length, emptyPages: parsed.emptyPages ?? 0, reportDate: reportDate ?? null, reportDateSource: reportDateSource ?? null, parserVersion: PARSER_VERSION, embeddingModel, processedAt: now(), error: null }
    await updateDocument(docId, summary)
    return summary
  } catch (error) {
    await updateDocument(docId, { status: 'failed', error: error.message }).catch(() => {})
    throw error
  }
}
