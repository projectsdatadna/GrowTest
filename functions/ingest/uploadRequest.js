/**
 * Validation of an uploaded file: type, size, a date, and that the bytes really are what the
 * extension says (so garbage is never sent to the model). Pure.
 */

import { detectReportDate, isoDate } from './reportDate.js'
import { istToday } from '../assistant/dateFilter.js'

// Cloud Functions' request body parser rejects bodies over 10 MB before the app sees them.
export const MAX_FILE_BYTES = 9 * 1024 * 1024
export const FILE_TYPES = {
  pdf: { mimeType: 'application/pdf', kind: 'pdf' },
  xlsx: { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', kind: 'sheet' },
  csv: { mimeType: 'text/csv', kind: 'sheet' },
}

export const extensionOf = (fileName) => (/\.([A-Za-z0-9]+)$/.exec(fileName)?.[1] || '').toLowerCase()

// No path separators or control characters; keeps the name readable.
export function safeFileName(fileName) {
  const base = String(fileName).split(/[\\/]/).pop().replace(/[^\w.\- ()&+]/g, '_').replace(/\s+/g, ' ').trim()
  return base.slice(0, 120) || 'file'
}

/** { fileName, sizeBytes, reportDate?, title? } -> { error } | { value }. */
export function validateUpload({ fileName, sizeBytes, reportDate, title } = {}, options) {
  if (typeof fileName !== 'string' || !fileName.trim()) return { error: 'The file name is missing' }
  const extension = extensionOf(fileName)
  const type = FILE_TYPES[extension]
  if (!type) return { error: `Unsupported file type .${extension || '?'} - upload ${Object.keys(FILE_TYPES).map((e) => `.${e}`).join(', ')}` }
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return { error: 'The file is empty' }
  if (sizeBytes > MAX_FILE_BYTES) return { error: `The file is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB` }

  let date = null
  let dateSource = null
  if (reportDate != null && reportDate !== '') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(reportDate))
    date = m ? isoDate(+m[1], +m[2], +m[3], options) : null
    if (!date) return { error: 'The report date must be a valid date, YYYY-MM-DD' }
    dateSource = 'user'
  } else {
    const found = detectReportDate({ fileName }, options)
    if (found) ({ date, source: dateSource } = { date: found.date, source: found.source })
    else {
      // No date given or found in the name: the day it is uploaded, so every version can be told apart (editable afterwards).
      date = istToday(options?.now).toISOString().slice(0, 10)
      dateSource = 'upload'
    }
  }
  const safeName = safeFileName(fileName)
  return {
    value: {
      fileName: safeName,
      mimeType: type.mimeType,
      kind: type.kind,
      sizeBytes,
      title: (typeof title === 'string' && title.trim() ? title.trim() : safeName.replace(/\.[A-Za-z0-9]+$/, '')).slice(0, 200),
      reportDate: date,
      reportDateSource: dateSource,
    },
  }
}

/** null when the bytes look like the claimed type, else a message. */
export function sniffContent(buffer, extension) {
  const head = buffer.subarray(0, 1024)
  if (extension === 'pdf') return head.includes('%PDF-') ? null : 'This is not a valid PDF file'
  if (extension === 'xlsx') return head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04 ? null : 'This is not a valid .xlsx workbook'
  if (extension === 'csv') return buffer.subarray(0, 8192).includes(0) ? 'This does not look like a CSV text file' : null
  return 'Unsupported file type'
}
