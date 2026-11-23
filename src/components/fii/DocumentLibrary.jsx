/**
 * The persisted document library: every uploaded file with its metadata. Download the original, fix a
 * title / report date (the document is re-indexed so searches use the new date), or delete (hidden
 * from search; the file itself stays in storage).
 */

import { useCallback, useEffect, useState } from 'react'
import { listDocuments, updateDocument, deleteDocument, documentDownloadUrl } from '../../services/api'
import Spinner from '../Spinner'

const fieldClass = 'bg-surface-container-low border border-terminal-border rounded-lg text-xs px-sm py-[2px] text-on-surface'
const TYPE_LABEL = { fii_report: 'FII report', general: 'Document' }
const STATUS_STYLE = { ready: 'text-bullish', failed: 'text-bearish', processing: 'text-on-surface-variant', awaiting_upload: 'text-on-surface-variant' }
const formatSize = (b) => (!b ? '' : b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`)

function Row({ doc, onChanged }) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(doc.title)
  const [reportDate, setReportDate] = useState(doc.reportDate || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      const fields = {}
      if (title !== doc.title) fields.title = title
      if (reportDate !== (doc.reportDate || '')) fields.reportDate = reportDate || null
      if (Object.keys(fields).length) await updateDocument(doc.id, fields)
      setEditing(false)
      onChanged()
    } catch (err) {
      setError(err?.response?.data?.error || err.message)
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    if (!window.confirm(`Delete “${doc.title}”? It will no longer be searchable.`)) return
    setBusy(true)
    try {
      await deleteDocument(doc.id)
      onChanged()
    } catch (err) {
      setError(err?.response?.data?.error || err.message)
      setBusy(false)
    }
  }

  return (
    <tr className="border-t border-outline-variant align-top">
      <td className="py-xs pr-sm">
        {editing ? <input value={title} onChange={(e) => setTitle(e.target.value)} className={`${fieldClass} w-full`} aria-label="Title" /> : <span className="text-on-surface">{doc.title}</span>}
        {doc.status === 'failed' && doc.error && <div className="text-[11px] text-bearish">{doc.error}</div>}
        {error && <div className="text-[11px] text-bearish">{error}</div>}
      </td>
      <td className="py-xs pr-sm text-on-surface-variant whitespace-nowrap">{TYPE_LABEL[doc.docType] || doc.docType}</td>
      <td className="py-xs pr-sm font-mono whitespace-nowrap">
        {editing ? <input type="date" value={reportDate} onChange={(e) => setReportDate(e.target.value)} className={fieldClass} aria-label="Report date" /> : doc.reportDate || <span className="text-on-surface-variant">—</span>}
      </td>
      <td className="py-xs pr-sm text-on-surface-variant whitespace-nowrap">{[doc.pageCount != null && `${doc.pageCount} p`, doc.chunkCount != null && `${doc.chunkCount} passages`, formatSize(doc.sizeBytes)].filter(Boolean).join(' · ') || '—'}</td>
      <td className={`py-xs pr-sm whitespace-nowrap ${STATUS_STYLE[doc.status] || ''}`}>{doc.status}</td>
      <td className="py-xs pr-sm text-on-surface-variant whitespace-nowrap">{doc.uploadedAt ? new Date(doc.uploadedAt).toLocaleDateString() : ''}</td>
      <td className="py-xs whitespace-nowrap text-right">
        {busy ? <Spinner /> : editing ? (
          <>
            <button type="button" onClick={save} className="text-primary hover:underline mr-sm">Save</button>
            <button type="button" onClick={() => { setEditing(false); setTitle(doc.title); setReportDate(doc.reportDate || '') }} className="text-on-surface-variant hover:underline">Cancel</button>
          </>
        ) : (
          <>
            <a href={documentDownloadUrl(doc.id)} className="text-primary hover:underline mr-sm" aria-label={`Download ${doc.title}`}>Download</a>
            <button type="button" onClick={() => setEditing(true)} className="text-primary hover:underline mr-sm">Edit</button>
            <button type="button" onClick={remove} className="text-bearish hover:underline">Delete</button>
          </>
        )}
      </td>
    </tr>
  )
}

export default function DocumentLibrary({ docType = '', refreshKey = 0, onChanged }) {
  const [documents, setDocuments] = useState(null)
  const [error, setError] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [bump, setBump] = useState(0)

  useEffect(() => {
    let cancelled = false
    listDocuments({ docType: docType || undefined, from: from || undefined, to: to || undefined })
      .then((r) => {
        if (cancelled) return
        setDocuments(r.documents)
        setError('')
      })
      .catch((err) => !cancelled && setError(err?.response?.data?.error || err.message))
    return () => {
      cancelled = true
    }
  }, [docType, from, to, refreshKey, bump])

  const changed = useCallback(() => {
    setBump((b) => b + 1)
    onChanged?.()
  }, [onChanged])

  return (
    <div className="flex flex-col gap-sm">
      <div className="flex items-center gap-sm flex-wrap text-xs text-on-surface-variant">
        <span>Report date</span>
        <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className={fieldClass} aria-label="From report date" />
        <span>to</span>
        <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className={fieldClass} aria-label="To report date" />
        {(from || to) && <button type="button" onClick={() => { setFrom(''); setTo('') }} className="text-primary hover:underline">Clear</button>}
        {documents && <span className="ml-auto">{documents.length} document{documents.length === 1 ? '' : 's'}</span>}
      </div>
      {error && <div className="text-sm text-bearish">{error}</div>}
      {!documents && !error && <Spinner />}
      {documents && documents.length === 0 && <div className="text-sm text-on-surface-variant">No documents yet. Upload one above.</div>}
      {documents && documents.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs text-left">
            <thead className="text-[11px] uppercase tracking-wide text-on-surface-variant">
              <tr>
                {['Title', 'Type', 'Report date', 'Size', 'Status', 'Uploaded', ''].map((h) => (
                  <th key={h} className="pb-xs pr-sm font-normal">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {documents.map((doc) => (
                <Row key={`${doc.id}:${doc.title}:${doc.reportDate}:${doc.status}`} doc={doc} onChanged={changed} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
