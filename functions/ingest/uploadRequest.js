/**
 * Validation of an uploaded file: type, size, a date, and that the bytes really are what the
 * extension says (so garbage is never sent to the model). Pure.
 */

import { detectReportDate, isoDate } from './reportDate.js'
import { istToday } from '../assistant/dateFilter.js'
import { hasUtf16Bom } from './text.js'

// Cloud Functions' request body parser rejects bodies over 10 MB before the app sees them.
export const MAX_FILE_BYTES = 9 * 1024 * 1024
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml'
// Every type we accept. `zip` / `ole` = what the file must start with (so garbage never reaches the model); `text` = CSV / JSON.
export const FILE_TYPES = {
  pdf: { mimeType: 'application/pdf', kind: 'pdf' },
  // Excel: the XML formats are zips, the old .xls / .xlt are OLE2 containers, .xlsb is a zip of binary parts.
  xlsx: { mimeType: `${XLSX_MIME}.sheet`, kind: 'sheet', container: 'zip' },
  xlsm: { mimeType: 'application/vnd.ms-excel.sheet.macroEnabled.12', kind: 'sheet', container: 'zip' },
  xltx: { mimeType: `${XLSX_MIME}.template`, kind: 'sheet', container: 'zip' },
  xltm: { mimeType: 'application/vnd.ms-excel.template.macroEnabled.12', kind: 'sheet', container: 'zip' },
  xlsb: { mimeType: 'application/vnd.ms-excel.sheet.binary.macroEnabled.12', kind: 'sheet', container: 'zip' },
  xls: { mimeType: 'application/vnd.ms-excel', kind: 'sheet', container: 'ole' },
  xlt: { mimeType: 'application/vnd.ms-excel', kind: 'sheet', container: 'ole' },
  ods: { mimeType: 'application/vnd.oasis.opendocument.spreadsheet', kind: 'sheet', container: 'zip' },
  csv: { mimeType: 'text/csv', kind: 'sheet', container: 'text' },
  json: { mimeType: 'application/json', kind: 'json', container: 'text' },
}

export const extensionOf = (fileName) => (/\.([A-Za-z0-9]+)$/.exec(fileName)?.[1] || '').toLowerCase()

// No path separators or control characters; keeps the name readable.
export function safeFileName(fileName) {
  const base = String(fileName).split(/[\\/]/).pop().replace(/[^\w.\- ()&+]/g, '_').replace(/\s+/g, ' ').trim()
  return base.slice(0, 120) || 'file'
}

export const MAX_REPORT_NAME = 120
/** A report name trimmed to its limit, or '' when there is none. */
export const cleanReportName = (value) => (typeof value === 'string' ? value.trim().slice(0, MAX_REPORT_NAME) : '')

/** { fileName, sizeBytes, reportDate?, title?, reportName? } -> { error } | { value }. reportName = the NSE report the file is for (set from the Assistant's report popup). */
export function validateUpload({ fileName, sizeBytes, reportDate, title, reportName } = {}, options) {
  if (typeof fileName !== 'string' || !fileName.trim()) return { error: 'The file name is missing' }
  const extension = extensionOf(fileName)
  const type = FILE_TYPES[extension]
  if (!type) return { error: `Unsupported file type .${extension || '?'} - upload PDF, Excel (.xlsx .xlsm .xls .xlsb ...), .csv or .json` }
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
      ...(cleanReportName(reportName) ? { reportName: cleanReportName(reportName) } : {}),
    },
  }
}

/** null when the bytes look like the claimed type, else a message. */
export function sniffContent(buffer, extension) {
  const head = buffer.subarray(0, 1024)
  const type = FILE_TYPES[extension]
  if (extension === 'pdf') return head.includes('%PDF-') ? null : 'This is not a valid PDF file'
  if (type?.container === 'zip') return head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04 ? null : `This is not a valid .${extension} workbook`
  // The old binary .xls: an OLE2 container. (Some tools save an HTML or XML table with an .xls name: not supported.)
  if (type?.container === 'ole') return [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((b, i) => head[i] === b) ? null : `This is not a valid .${extension} workbook`
  if (type?.container === 'text') return hasUtf16Bom(buffer) || !buffer.subarray(0, 8192).includes(0) ? null : `This does not look like a ${extension.toUpperCase()} text file`
  return 'Unsupported file type'
}
