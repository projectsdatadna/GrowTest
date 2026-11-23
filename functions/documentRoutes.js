/**
 * Document library API (shared by server.js; functions/index.js registers it once the
 * dedicated long-running function exists - ingestion needs more than growtestApi's
 * 120 s / 256 MiB for big PDFs).
 *
 *   POST   /docs/upload-url   validate + create the record + return a resumable upload URL
 *   POST   /docs/:id/process  after the browser finished the upload: parse, chunk, embed
 *   GET    /docs              list (docType, status, from, to)
 *   GET    /docs/:id          one document's metadata
 *   PATCH  /docs/:id          title / tags / reportDate (a changed date or title re-indexes)
 *   GET    /docs/:id/download stream the original file
 *   DELETE /docs/:id          soft delete (file kept, removed from search)
 */

import { validateUploadRequest, MAX_FILE_BYTES, DOC_TYPES } from './ingest/uploadRequest.js'
import { storagePathFor, createResumableUploadUrl, statFile, openReadStream } from './documentStorage.js'
import { ingestDocumentWithDefaults } from './ingest/ingestDefaults.js'
import { isoDate } from './ingest/reportDate.js'
import { buildFiiDeps } from './fii/deps.js'
import { extractFiiMetrics } from './fii/metrics.js'
import {
  createDocumentRecord,
  getDocumentRecord,
  updateDocumentRecord,
  listDocumentRecords,
  findDocumentBySha256,
  softDeleteDocument,
} from './documentsFirestoreClient.js'

const ID_PATTERN = /^[A-Za-z0-9]{10,40}$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

// Public shape: no storage path.
const publicDoc = ({ storagePath, ...doc }) => doc

// After a document is indexed: FII reports also get their figures extracted (best effort -
// a failure is reported, never undoes the indexing; the Compare tab can re-run it).
const defaultAfterIngest = async (doc) => {
  if (doc.docType !== 'fii_report') return null
  const record = await extractFiiMetrics(doc.id, buildFiiDeps())
  return { status: record.status, warnings: record.warnings }
}

export function registerDocumentRoutes(app, { ingest = ingestDocumentWithDefaults, afterIngest = defaultAfterIngest } = {}) {
  const runAfterIngest = async (doc) => {
    try {
      return { fii: await afterIngest(doc) }
    } catch (error) {
      return { fii: { status: 'failed', error: error.message } }
    }
  }

  const withDoc = (handler) => async (req, res) => {
    try {
      if (!ID_PATTERN.test(req.params.id)) return res.status(400).json({ error: 'Invalid document id' })
      const doc = await getDocumentRecord(req.params.id)
      if (!doc || doc.deleted) return res.status(404).json({ error: 'Document not found' })
      await handler(req, res, doc)
    } catch (error) {
      console.error(`Error in ${req.method} ${req.path}:`, error.message)
      if (!res.headersSent) res.status(500).json({ error: error.message })
    }
  }

  app.post('/docs/upload-url', async (req, res) => {
    try {
      const { error, value } = validateUploadRequest(req.body)
      if (error) return res.status(400).json({ error })

      const existing = await findDocumentBySha256(value.sha256)
      if (existing && ['processing', 'ready'].includes(existing.status)) {
        return res.json({ status: 'DUPLICATE', duplicate: true, document: publicDoc(existing) })
      }
      // An abandoned / failed earlier attempt of the same file is reused instead of piling up records.
      const fields = { ...value, status: 'awaiting_upload', error: null, uploadedBy: null }
      const docId = existing?.id ?? (await createDocumentRecord({ ...fields, storagePath: null }))
      const storagePath = storagePathFor(docId, value.fileName)
      await updateDocumentRecord(docId, { ...fields, storagePath })
      const uploadUrl = await createResumableUploadUrl(storagePath, { contentType: value.mimeType, origin: req.headers.origin })
      res.json({ status: 'SUCCESS', duplicate: false, docId, uploadUrl, maxBytes: MAX_FILE_BYTES })
    } catch (error) {
      console.error('Error creating upload URL:', error.message)
      res.status(500).json({ error: error.message })
    }
  })

  app.post('/docs/:id/process', withDoc(async (req, res, doc) => {
    const stat = await statFile(doc.storagePath)
    if (!stat.exists) return res.status(409).json({ error: 'The file has not been uploaded yet' })
    if (stat.size > MAX_FILE_BYTES) return res.status(413).json({ error: 'File is too large' })
    try {
      const summary = await ingest(doc.id)
      const extras = await runAfterIngest(doc)
      res.json({ status: 'SUCCESS', summary, ...extras, document: publicDoc(await getDocumentRecord(doc.id)) })
    } catch (error) {
      // ingest() already stored status=failed + the reason on the document.
      res.status(422).json({ error: error.message, document: publicDoc(await getDocumentRecord(doc.id)) })
    }
  }))

  app.get('/docs', async (req, res) => {
    try {
      const { docType, status, from, to } = req.query
      if (docType && !DOC_TYPES.includes(docType)) return res.status(400).json({ error: `docType must be one of ${DOC_TYPES.join(', ')}` })
      for (const [name, value] of [['from', from], ['to', to]]) if (value && !DATE_PATTERN.test(value)) return res.status(400).json({ error: `${name} must be YYYY-MM-DD` })
      const docs = await listDocumentRecords({ docType, status, from, to })
      res.json({ status: 'SUCCESS', total: docs.length, documents: docs.map(publicDoc) })
    } catch (error) {
      console.error('Error listing documents:', error.message)
      res.status(500).json({ error: error.message })
    }
  })

  app.get('/docs/:id', withDoc(async (_req, res, doc) => res.json({ status: 'SUCCESS', document: publicDoc(doc) })))

  app.patch('/docs/:id', withDoc(async (req, res, doc) => {
    const { title, tags, reportDate } = req.body || {}
    const fields = {}
    if (title !== undefined) {
      if (typeof title !== 'string' || !title.trim()) return res.status(400).json({ error: 'title must be a non-empty string' })
      fields.title = title.trim().slice(0, 200)
    }
    if (tags !== undefined) {
      if (!Array.isArray(tags)) return res.status(400).json({ error: 'tags must be an array' })
      fields.tags = [...new Set(tags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 10)
    }
    if (reportDate !== undefined) {
      const m = DATE_PATTERN.test(String(reportDate)) ? String(reportDate).split('-').map(Number) : null
      const date = m ? isoDate(...m) : null
      if (!date && !(reportDate === null && doc.docType !== 'fii_report')) return res.status(400).json({ error: 'reportDate must be a valid date, YYYY-MM-DD (required for FII reports)' })
      fields.reportDate = date
      fields.reportDateSource = date ? 'user' : null
    }
    await updateDocumentRecord(doc.id, fields)
    // Title and date are part of every chunk's embedded text, so a change re-indexes the document.
    const reindex = doc.status === 'ready' && ((fields.title && fields.title !== doc.title) || (fields.reportDate !== undefined && fields.reportDate !== doc.reportDate))
    if (reindex) {
      try {
        await ingest(doc.id)
      } catch (error) {
        return res.status(422).json({ error: `Saved, but re-indexing failed: ${error.message}`, document: publicDoc(await getDocumentRecord(doc.id)) })
      }
    }
    const extras = reindex ? await runAfterIngest(doc) : {}
    res.json({ status: 'SUCCESS', reindexed: reindex, ...extras, document: publicDoc(await getDocumentRecord(doc.id)) })
  }))

  app.get('/docs/:id/download', withDoc(async (_req, res, doc) => {
    if (!doc.storagePath) return res.status(409).json({ error: 'The file has not been uploaded yet' })
    res.setHeader('Content-Type', doc.mimeType || 'application/octet-stream')
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(doc.fileName)}`)
    const stream = openReadStream(doc.storagePath)
    stream.on('error', (error) => {
      console.error('Error streaming document:', error.message)
      if (!res.headersSent) res.status(500).json({ error: error.message })
      else res.destroy()
    })
    stream.pipe(res)
  }))

  app.delete('/docs/:id', withDoc(async (_req, res, doc) => {
    await softDeleteDocument(doc.id)
    res.json({ status: 'SUCCESS' })
  }))
}
