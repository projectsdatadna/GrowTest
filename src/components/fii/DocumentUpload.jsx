/**
 * Pick or drop PDF / Excel / CSV files, set their type and report date, and upload them. Each file is
 * hashed, sent straight to Cloud Storage and indexed; duplicates (same contents) are recognised.
 * FII reports need a report date (taken from the file name when it contains one).
 */

import { useRef, useState } from 'react'
import { uploadDocument } from '../../services/api'
import Spinner from '../Spinner'

const MAX_BYTES = 50 * 1024 * 1024
const EXTENSIONS = ['pdf', 'xlsx', 'csv']
const STAGE_LABEL = { hashing: 'Checking…', uploading: 'Uploading…', processing: 'Reading & indexing…' }
const fieldClass = 'bg-surface-container-low border border-terminal-border rounded-lg text-xs px-sm py-[2px] text-on-surface'

const extensionOf = (name) => (/\.([A-Za-z0-9]+)$/.exec(name)?.[1] || '').toLowerCase()
const formatSize = (bytes) => (bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`)

export default function DocumentUpload({ defaultDocType = 'fii_report', onUploaded }) {
  const [items, setItems] = useState([])
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef(null)
  const nextId = useRef(1)

  const patch = (id, fields) => setItems((current) => current.map((it) => (it.id === id ? { ...it, ...fields } : it)))

  const addFiles = (fileList) => {
    const added = [...fileList].map((file) => {
      let error = null
      if (!EXTENSIONS.includes(extensionOf(file.name))) error = `Unsupported type - use ${EXTENSIONS.map((e) => `.${e}`).join(', ')}`
      else if (file.size > MAX_BYTES) error = 'Larger than 50 MB'
      return { id: nextId.current++, file, docType: defaultDocType, reportDate: '', status: error ? 'error' : 'ready', message: error, stage: null, progress: 0 }
    })
    setItems((current) => [...current, ...added])
  }

  const upload = async (item) => {
    patch(item.id, { status: 'busy', message: null, progress: 0 })
    try {
      const result = await uploadDocument(item.file, { docType: item.docType, reportDate: item.reportDate }, {
        onStage: (stage) => patch(item.id, { stage }),
        onProgress: (progress) => patch(item.id, { progress }),
      })
      if (result.duplicate) patch(item.id, { status: 'duplicate', message: `Already uploaded as “${result.document.title}”` })
      else if (result.document.status === 'failed') patch(item.id, { status: 'error', message: result.document.error || 'Indexing failed' })
      else {
        const note = result.fii && result.fii.status !== 'ready' ? ` (FII figures could not be extracted${result.fii.error ? `: ${result.fii.error}` : ''})` : ''
        patch(item.id, { status: 'done', message: `Indexed ${result.document.chunkCount ?? ''} passages${result.document.reportDate ? ` · report date ${result.document.reportDate}` : ''}${note}` })
      }
      onUploaded?.(result)
    } catch (err) {
      patch(item.id, { status: 'error', message: err?.response?.data?.error || err.message })
    }
  }

  const uploadAll = async () => {
    for (const item of items.filter((it) => it.status === 'ready' || (it.status === 'error' && !it.message?.startsWith('Unsupported') && !it.message?.startsWith('Larger')))) {
      // sequential: indexing is the slow part and each file is its own request
      await upload(item)
    }
  }

  const pending = items.filter((it) => it.status === 'ready' || it.status === 'error').some((it) => it.status === 'ready' || !/^(Unsupported|Larger)/.test(it.message || ''))
  const busy = items.some((it) => it.status === 'busy')

  return (
    <div className="flex flex-col gap-sm">
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files) }}
        className={`rounded-xl border-2 border-dashed p-lg text-center text-sm ${dragging ? 'border-primary bg-surface-container-highest' : 'border-outline-variant'} text-on-surface-variant`}
      >
        <p>Drop PDF, Excel or CSV files here, or</p>
        <button type="button" onClick={() => inputRef.current?.click()} className="mt-xs px-md py-xs rounded-lg border border-outline-variant text-on-surface">
          Choose files
        </button>
        <input ref={inputRef} type="file" multiple accept=".pdf,.xlsx,.csv" className="hidden" aria-label="Choose files to upload" onChange={(e) => { addFiles(e.target.files); e.target.value = '' }} />
        <p className="text-[11px] pt-xs">Up to 50 MB each. Kept permanently with their report date; delete them from the library only if you really want them gone.</p>
      </div>

      {items.length > 0 && (
        <ul className="flex flex-col gap-xs">
          {items.map((it) => (
            <li key={it.id} className="glass-panel rounded-lg px-md py-sm flex flex-col gap-xs">
              <div className="flex items-center gap-sm flex-wrap">
                <span className="text-sm text-on-surface truncate max-w-[320px]" title={it.file.name}>{it.file.name}</span>
                <span className="text-[11px] text-on-surface-variant">{formatSize(it.file.size)}</span>
                <select value={it.docType} onChange={(e) => patch(it.id, { docType: e.target.value })} disabled={it.status === 'busy' || it.status === 'done'} className={fieldClass} aria-label={`Type of ${it.file.name}`}>
                  <option value="fii_report">FII report</option>
                  <option value="general">Other document</option>
                </select>
                <label className="flex items-center gap-xs text-[11px] text-on-surface-variant">
                  Report date
                  <input type="date" value={it.reportDate} onChange={(e) => patch(it.id, { reportDate: e.target.value })} disabled={it.status === 'busy' || it.status === 'done'} className={fieldClass} aria-label={`Report date of ${it.file.name}`} />
                </label>
                {it.status === 'busy' && (
                  <span className="text-xs text-on-surface-variant flex items-center gap-xs"><Spinner />{STAGE_LABEL[it.stage] || 'Working…'}{it.stage === 'uploading' ? ` ${Math.round(it.progress * 100)}%` : ''}</span>
                )}
                {(it.status === 'ready' || it.status === 'done' || it.status === 'duplicate') && (
                  <button type="button" onClick={() => setItems((c) => c.filter((x) => x.id !== it.id))} className="ml-auto text-xs text-on-surface-variant hover:text-on-surface" aria-label={`Remove ${it.file.name} from the list`}>✕</button>
                )}
              </div>
              {it.message && <div className={`text-xs ${it.status === 'error' ? 'text-bearish' : 'text-on-surface-variant'}`}>{it.message}</div>}
              {it.docType === 'fii_report' && !it.reportDate && it.status === 'ready' && <div className="text-[11px] text-on-surface-variant">No date set - it will be read from the file name if it has one.</div>}
            </li>
          ))}
        </ul>
      )}

      {items.length > 0 && (
        <div className="flex gap-sm">
          <button type="button" onClick={uploadAll} disabled={!pending || busy} className="px-md py-sm rounded-lg bg-primary-container text-on-primary-container text-sm font-medium disabled:opacity-50">
            Upload
          </button>
          <button type="button" onClick={() => setItems((c) => c.filter((it) => it.status === 'busy'))} disabled={busy} className="px-md py-sm rounded-lg border border-outline-variant text-sm text-on-surface-variant">
            Clear list
          </button>
        </div>
      )}
    </div>
  )
}
