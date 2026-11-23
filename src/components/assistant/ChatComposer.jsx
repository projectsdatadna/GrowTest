/**
 * The message box of the chat widget: a text area, a paperclip and drag-and-drop for files, and the
 * chips of the files waiting to be sent. Each file is uploaded (to Firestore, via the server) as soon
 * as it is picked, so by the time the question is sent the chip only carries a file id.
 */

import { useRef, useState } from 'react'
import { uploadFile, updateFile, errorText, MAX_UPLOAD_BYTES, UPLOAD_EXTENSIONS } from '../../services/api'
import Spinner from '../Spinner'

const extensionOf = (name) => (/\.([A-Za-z0-9]+)$/.exec(name)?.[1] || '').toLowerCase()
const formatSize = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`)

/** Chips: { key, id?, title, reportDate, sizeBytes, status: 'uploading' | 'ready' | 'error', progress, message } */
export function FileChip({ chip, onChange, onRemove }) {
  const [saving, setSaving] = useState(false)
  const setDate = async (value) => {
    onChange({ reportDate: value || null })
    if (!chip.id) return
    setSaving(true)
    try {
      await updateFile(chip.id, { reportDate: value || null })
    } catch (err) {
      onChange({ message: errorText(err) })
    } finally {
      setSaving(false)
    }
  }
  return (
    <li className="rounded-lg border border-outline-variant bg-surface-container-low px-sm py-xs text-xs flex flex-col gap-[2px]">
      <div className="flex items-center gap-xs">
        <span className="material-symbols-outlined text-[16px] text-on-surface-variant" aria-hidden="true">{/\.(xlsx|csv)$/i.test(chip.title) ? 'table_chart' : 'description'}</span>
        <span className="flex-1 min-w-0 truncate text-on-surface" title={chip.title}>{chip.title}</span>
        <span className="text-[11px] text-on-surface-variant shrink-0">{formatSize(chip.sizeBytes)}</span>
        <button type="button" onClick={onRemove} aria-label={`Remove ${chip.title}`} className="text-on-surface-variant hover:text-on-surface">✕</button>
      </div>
      {chip.status === 'uploading' && (
        <div className="flex items-center gap-xs text-on-surface-variant"><Spinner />Uploading {Math.round((chip.progress || 0) * 100)}%</div>
      )}
      {chip.status === 'ready' && (
        <label className="flex items-center gap-xs text-[11px] text-on-surface-variant">
          Report date
          <input
            type="date"
            value={chip.reportDate || ''}
            onChange={(e) => setDate(e.target.value)}
            aria-label={`Report date of ${chip.title}`}
            className="bg-surface-container border border-terminal-border rounded px-xs py-[1px] text-[11px] text-on-surface"
          />
          {saving && <Spinner />}
          {!chip.reportDate && <span>(not found in the name — set it so “10 Nov” finds this file)</span>}
        </label>
      )}
      {chip.message && <div className={chip.status === 'error' ? 'text-bearish' : 'text-on-surface-variant'}>{chip.message}</div>}
    </li>
  )
}

export default function ChatComposer({ chips, setChips, onSend, busy, addFilesRef }) {
  const [text, setText] = useState('')
  const inputRef = useRef(null)
  const nextKey = useRef(1)

  const patchChip = (key, fields) => setChips((current) => current.map((c) => (c.key === key ? { ...c, ...fields } : c)))

  const addFiles = (fileList) => {
    for (const file of fileList) {
      const key = `up${nextKey.current++}`
      const base = { key, title: file.name.replace(/\.[^.]+$/, ''), reportDate: null, sizeBytes: file.size, progress: 0 }
      if (!UPLOAD_EXTENSIONS.includes(extensionOf(file.name))) {
        setChips((c) => [...c, { ...base, status: 'error', message: `Unsupported type - use ${UPLOAD_EXTENSIONS.map((e) => `.${e}`).join(', ')}` }])
        continue
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        setChips((c) => [...c, { ...base, status: 'error', message: `Larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB` }])
        continue
      }
      setChips((c) => [...c, { ...base, status: 'uploading' }])
      uploadFile(file, { onProgress: (progress) => patchChip(key, { progress }) })
        .then(({ file: stored, duplicate }) => patchChip(key, { status: 'ready', id: stored.id, title: stored.title, reportDate: stored.reportDate, sizeBytes: stored.sizeBytes, message: duplicate ? 'This file was already stored - using the existing copy.' : null }))
        .catch((err) => patchChip(key, { status: 'error', message: errorText(err) }))
    }
  }

  if (addFilesRef) addFilesRef.current = addFiles // lets the widget hand over files dropped anywhere on it

  const uploading = chips.some((c) => c.status === 'uploading')
  const ready = chips.filter((c) => c.status === 'ready')
  const canSend = !busy && !uploading && text.trim().length > 0

  const submit = () => {
    if (!canSend) return
    const question = text
    setText('')
    onSend(question, () => setText(question))
  }

  return (
    <div className="border-t border-outline-variant p-sm flex flex-col gap-xs">
      {chips.length > 0 && (
        <ul className="flex flex-col gap-xs max-h-[150px] overflow-y-auto" aria-label="Attached files">
          {chips.map((chip) => (
            <FileChip key={chip.key} chip={chip} onChange={(fields) => patchChip(chip.key, fields)} onRemove={() => setChips((c) => c.filter((x) => x.key !== chip.key))} />
          ))}
        </ul>
      )}
      <div className="flex items-end gap-xs">
        <button type="button" onClick={() => inputRef.current?.click()} title="Attach a PDF, Excel or CSV file" aria-label="Attach a file" className="p-sm rounded-lg text-on-surface-variant hover:bg-surface-container-highest">
          <span className="material-symbols-outlined">attach_file</span>
        </button>
        <input ref={inputRef} type="file" multiple accept=".pdf,.xlsx,.csv" className="hidden" aria-label="Choose files" onChange={(e) => { addFiles(e.target.files); e.target.value = '' }} />
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          rows={2}
          maxLength={4000}
          placeholder={ready.length ? 'Ask about the attached files…' : 'Ask a question, or attach a file…'}
          aria-label="Your message"
          className="flex-1 bg-surface-container-low border border-terminal-border rounded-lg text-sm px-md py-sm text-on-surface resize-none"
        />
        <button type="button" onClick={submit} disabled={!canSend} aria-label="Send" title={uploading ? 'Wait for the upload to finish' : 'Send'} className="p-sm rounded-lg bg-primary-container text-on-primary-container disabled:opacity-50">
          <span className="material-symbols-outlined">send</span>
        </button>
      </div>
    </div>
  )
}
