/**
 * Validation of POST /docs/upload-url. Pure: returns { error } or { value }.
 */

import { detectReportDate, isoDate } from './reportDate.js'

export const DOC_TYPES = ['fii_report', 'general']
export const MAX_FILE_BYTES = 50 * 1024 * 1024
export const ALLOWED_EXTENSIONS = { pdf: 'application/pdf', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv' }

export const extensionOf = (fileName) => (/\.([A-Za-z0-9]+)$/.exec(fileName)?.[1] || '').toLowerCase()

// No path separators or control characters; keeps the name readable.
export function safeFileName(fileName) {
  const base = String(fileName).split(/[\\/]/).pop().replace(/[^\w.\- ()&+]/g, '_').replace(/\s+/g, ' ').trim()
  return base.slice(0, 120) || 'document'
}

export function validateUploadRequest(body, options) {
  const { fileName, sizeBytes, sha256, docType = 'general', title, tags, reportDate } = body || {}
  if (typeof fileName !== 'string' || !fileName.trim()) return { error: 'fileName is required' }
  const ext = extensionOf(fileName)
  if (!ALLOWED_EXTENSIONS[ext]) return { error: `Unsupported file type .${ext || '?'} - upload ${Object.keys(ALLOWED_EXTENSIONS).map((e) => `.${e}`).join(', ')}` }
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return { error: 'sizeBytes is required' }
  if (sizeBytes > MAX_FILE_BYTES) return { error: `File is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB` }
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(sha256)) return { error: 'sha256 (hex, 64 chars) is required' }
  if (!DOC_TYPES.includes(docType)) return { error: `docType must be one of ${DOC_TYPES.join(', ')}` }

  let date = null
  let dateSource = null
  if (reportDate != null && reportDate !== '') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(reportDate))
    date = m ? isoDate(+m[1], +m[2], +m[3], options) : null
    if (!date) return { error: 'reportDate must be a valid date, YYYY-MM-DD' }
    dateSource = 'user'
  } else {
    const found = detectReportDate({ fileName }, options)
    if (found) ({ date, source: dateSource } = { date: found.date, source: found.source })
  }
  // An FII comparison needs its date up front; other documents may get one detected from their text later.
  if (docType === 'fii_report' && !date) return { error: 'reportDate is required for FII reports (none could be read from the file name)' }

  const cleanTags = Array.isArray(tags) ? [...new Set(tags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 10) : []
  const safeName = safeFileName(fileName)
  return {
    value: {
      fileName: safeName,
      extension: ext,
      mimeType: ALLOWED_EXTENSIONS[ext],
      sizeBytes,
      sha256: sha256.toLowerCase(),
      docType,
      title: (typeof title === 'string' && title.trim() ? title.trim() : safeName.replace(/\.[A-Za-z0-9]+$/, '')).slice(0, 200),
      tags: cleanTags,
      reportDate: date,
      reportDateSource: dateSource,
    },
  }
}
