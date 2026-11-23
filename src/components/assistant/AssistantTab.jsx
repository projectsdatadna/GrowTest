/**
 * Assistant tab: saved conversations on the left, the chat on the right, and a scope bar to restrict
 * answers to a document type, a report-date range or specific documents.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Select from 'react-select'
import { listChatThreads, deleteChatThread, listDocuments } from '../../services/api'
import ChatPanel from './ChatPanel'

const selectClass = 'bg-surface-container-low border border-terminal-border rounded-lg text-sm px-md py-xs text-on-surface'

export default function AssistantTab() {
  const [threads, setThreads] = useState([])
  const [activeId, setActiveId] = useState(null) // thread highlighted in the list (null = new chat)
  const [loadId, setLoadId] = useState(null) // thread whose saved messages the chat loads on mount - changes only with panelKey
  const [panelKey, setPanelKey] = useState(0) // changing it remounts the chat
  const [docs, setDocs] = useState([])
  const [docType, setDocType] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [docIds, setDocIds] = useState([])
  const [error, setError] = useState('')

  const refreshThreads = useCallback(() => {
    listChatThreads().then((r) => setThreads(r.threads)).catch((err) => setError(err?.response?.data?.error || err.message))
  }, [])

  useEffect(() => {
    refreshThreads()
    listDocuments({ status: 'ready' }).then((r) => setDocs(r.documents)).catch(() => {})
  }, [refreshThreads])

  const scope = useMemo(() => {
    const s = {}
    if (docType) s.docType = docType
    if (from) s.from = from
    if (to) s.to = to
    if (docIds.length) s.docIds = docIds.map((o) => o.value)
    return s
  }, [docType, from, to, docIds])
  const docOptions = useMemo(() => docs.map((d) => ({ value: d.id, label: `${d.title}${d.reportDate ? ` (${d.reportDate})` : ''}` })), [docs])

  const open = (id) => {
    setActiveId(id)
    setLoadId(id)
    setPanelKey((k) => k + 1)
  }
  const remove = async (id) => {
    if (!window.confirm('Delete this conversation?')) return
    await deleteChatThread(id).catch(() => {})
    if (id === activeId) open(null)
    refreshThreads()
  }
  const onThreadChange = useCallback((id) => {
    setActiveId(id)
    refreshThreads()
  }, [refreshThreads])

  return (
    <div className="flex flex-col gap-md">
      <div>
        <h2 className="text-lg font-semibold text-on-surface">Assistant</h2>
        <p className="text-xs text-on-surface-variant">Ask questions about your uploaded documents. Answers cite the document, report date and page.</p>
      </div>

      <div className="flex items-center gap-sm flex-wrap" aria-label="Scope">
        <span className="text-xs text-on-surface-variant">Restrict to</span>
        <select value={docType} onChange={(e) => setDocType(e.target.value)} className={selectClass} aria-label="Document type">
          <option value="">All documents</option>
          <option value="fii_report">FII reports</option>
          <option value="general">Other documents</option>
        </select>
        <label className="flex items-center gap-xs text-xs text-on-surface-variant">
          From <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className={selectClass} aria-label="Report date from" />
        </label>
        <label className="flex items-center gap-xs text-xs text-on-surface-variant">
          To <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className={selectClass} aria-label="Report date to" />
        </label>
        <div className="min-w-[240px]">
          <Select isMulti options={docOptions} value={docIds} onChange={(v) => setDocIds(v || [])} placeholder="Specific documents…" classNamePrefix="rs" styles={{ control: (b) => ({ ...b, minHeight: 32, background: 'transparent' }), menu: (b) => ({ ...b, zIndex: 30 }) }} />
        </div>
      </div>

      <div className="grid md:grid-cols-[220px_minmax(0,1fr)] gap-md">
        <aside className="glass-panel rounded-xl p-sm flex flex-col gap-xs max-h-[70vh] overflow-y-auto" aria-label="Conversations">
          <button type="button" onClick={() => open(null)} className="px-md py-xs rounded-lg bg-primary-container text-on-primary-container text-sm font-medium">
            + New chat
          </button>
          {error && <div className="text-xs text-bearish">{error}</div>}
          {threads.map((t) => (
            <div key={t.id} className={`group flex items-center gap-xs rounded-lg px-sm py-xs text-sm cursor-pointer ${t.id === activeId ? 'bg-surface-container-highest text-on-surface' : 'text-on-surface-variant hover:text-on-surface'}`}>
              <button type="button" onClick={() => open(t.id)} className="flex-1 text-left truncate" title={t.title}>
                {t.title}
              </button>
              <button type="button" onClick={() => remove(t.id)} aria-label={`Delete conversation ${t.title}`} className="opacity-0 group-hover:opacity-100 focus:opacity-100 text-bearish text-xs">
                ✕
              </button>
            </div>
          ))}
          {threads.length === 0 && !error && <div className="text-xs text-on-surface-variant px-sm">No conversations yet.</div>}
        </aside>

        <div className="glass-panel rounded-xl p-md min-h-[60vh] flex flex-col">
          <ChatPanel
            key={panelKey}
            className="flex-1"
            scope={scope}
            initialThreadId={loadId}
            onThreadChange={onThreadChange}
            suggestions={['What did FIIs do in index futures in the latest report?', 'Compare the latest FII report with the previous one', 'Which report dates do we have?']}
          />
        </div>
      </div>
    </div>
  )
}
