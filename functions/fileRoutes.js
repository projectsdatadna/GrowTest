/**
 * File library API: upload, list, rename / re-date, download, delete.
 *
 *   POST   /files          the raw file as the request body; headers X-File-Name (URI-encoded),
 *                          optional X-Report-Date (YYYY-MM-DD) and X-Title. A file with the same
 *                          contents as an existing one is not stored twice.
 *   GET    /files          newest first
 *   PATCH  /files/:id      { title?, reportDate? }
 *   GET    /files/:id/download
 *   DELETE /files/:id      soft delete
 */

import crypto from 'node:crypto'
import express from 'express'
import * as defaultStore from './filesFirestoreClient.js'
import { validateUpload, sniffContent, extensionOf, MAX_FILE_BYTES } from './ingest/uploadRequest.js'
import { isoDate } from './ingest/reportDate.js'
import { parseXlsx, parseCsvBuffer } from './ingest/parseSheet.js'

const ID = /^[A-Za-z0-9]{10,40}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

/** What the browser sees of a file. */
export const publicFile = ({ id, title, fileName, mimeType, kind, reportDate, reportDateSource, sizeBytes, uploadedAt }) => ({ id, title, fileName, mimeType, kind, reportDate: reportDate ?? null, reportDateSource: reportDateSource ?? null, sizeBytes, uploadedAt })

const decodeHeader = (value) => {
  try {
    return decodeURIComponent(String(value ?? ''))
  } catch {
    return String(value ?? '')
  }
}

export function registerFileRoutes(app, { store = defaultStore } = {}) {
  const rawBody = express.raw({ type: () => true, limit: MAX_FILE_BYTES + 1024 * 1024 })
  const guard = (handler) => async (req, res) => {
    try {
      await handler(req, res)
    } catch (error) {
      console.error(`Error in ${req.method} ${req.path}:`, error.message)
      if (!res.headersSent) res.status(500).json({ error: error.message })
    }
  }
  const withFile = (handler) => guard(async (req, res) => {
    if (!ID.test(req.params.id)) return res.status(400).json({ error: 'Invalid file id' })
    const file = await store.getFile(req.params.id)
    if (!file || file.deleted) return res.status(404).json({ error: 'File not found' })
    await handler(req, res, file)
  })

  app.post(
    '/files',
    (req, res, next) =>
      rawBody(req, res, (err) => {
        if (!err) return next()
        res.status(err.status === 413 ? 413 : 400).json({ error: err.status === 413 ? `The file is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB` : 'Could not read the upload' })
      }),
    guard(async (req, res) => {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: 'Send the file as the raw request body' })
      const buffer = req.body
      const { error, value } = validateUpload({ fileName: decodeHeader(req.headers['x-file-name']), sizeBytes: buffer.length, reportDate: req.headers['x-report-date'], title: decodeHeader(req.headers['x-title']) || undefined })
      if (error) return res.status(400).json({ error })
      const extension = extensionOf(value.fileName)
      const sniffed = sniffContent(buffer, extension)
      if (sniffed) return res.status(422).json({ error: sniffed })
      if (value.kind === 'sheet') {
        try {
          const parsed = extension === 'xlsx' ? await parseXlsx(buffer) : parseCsvBuffer(buffer)
          if (!parsed.pages.length) return res.status(422).json({ error: 'The spreadsheet has no data' })
        } catch {
          return res.status(422).json({ error: 'Could not read the spreadsheet' })
        }
      }
      const sha256 = crypto.createHash('sha256').update(buffer).digest('hex')
      const existing = await store.findFileBySha256(sha256)
      if (existing) return res.json({ status: 'DUPLICATE', duplicate: true, file: publicFile(existing) })
      const file = await store.createFile({ ...value, sha256, ownerId: null }, buffer)
      res.status(201).json({ status: 'SUCCESS', duplicate: false, file: publicFile(file) })
    })
  )

  app.get('/files', guard(async (_req, res) => {
    const files = await store.listFiles()
    res.json({ status: 'SUCCESS', total: files.length, files: files.map(publicFile) })
  }))

  app.patch('/files/:id', withFile(async (req, res, file) => {
    const { title, reportDate } = req.body || {}
    const fields = {}
    if (title !== undefined) {
      if (typeof title !== 'string' || !title.trim()) return res.status(400).json({ error: 'The title must not be empty' })
      fields.title = title.trim().slice(0, 200)
    }
    if (reportDate !== undefined) {
      if (reportDate === null || reportDate === '') Object.assign(fields, { reportDate: null, reportDateSource: null })
      else {
        const m = DATE.test(String(reportDate)) ? String(reportDate).split('-').map(Number) : null
        const date = m ? isoDate(...m) : null
        if (!date) return res.status(400).json({ error: 'The report date must be a valid date, YYYY-MM-DD' })
        Object.assign(fields, { reportDate: date, reportDateSource: 'user' })
      }
    }
    if (!Object.keys(fields).length) return res.json({ status: 'SUCCESS', file: publicFile(file) })
    res.json({ status: 'SUCCESS', file: publicFile(await store.updateFile(file.id, fields)) })
  }))

  app.get('/files/:id/download', withFile(async (_req, res, file) => {
    const bytes = await store.getFileBytes(file)
    res.setHeader('Content-Type', file.mimeType || 'application/octet-stream')
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`)
    res.send(bytes)
  }))

  app.delete('/files/:id', withFile(async (_req, res, file) => {
    await store.softDeleteFile(file.id)
    res.json({ status: 'SUCCESS' })
  }))
}
