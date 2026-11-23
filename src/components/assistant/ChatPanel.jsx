/**
 * Chat with the document assistant: streamed answers, citations that open their source, the
 * dates/filters that were searched, and (in agent mode) the tools the assistant used.
 * `scope` ({docType, docIds, from, to}) restricts what it may read; it is read at send time.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { streamChat, getChatMessages, documentDownloadUrl } from '../../services/api'
import Spinner from '../Spinner'
import AnswerText from './AnswerText'

const MODES = [
  { key: 'rag', label: 'Documents Q&A', hint: 'Searches the uploaded documents and answers from them (fast, cheap).' },
  { key: 'agent', label: 'Agent', hint: 'Can also compare FII reports, calculate stoploss/target, fetch quotes and scanner signals (slower).' },
]

function describeFilter(filter) {
  if (!filter) return null
  if (filter.dates?.length) return `report date${filter.dates.length > 1 ? 's' : ''} ${filter.dates.join(', ')}`
  if (filter.from || filter.to) return `report dates ${filter.from || '…'} → ${filter.to || '…'}`
  return null
}

const TOOL_LABELS = { search_documents: 'Search documents', list_documents: 'List documents', get_fii_metrics: 'FII metrics', compare_fii: 'Compare FII', calc_stop_target: 'Stoploss/target', get_quote: 'Quote', get_notifications: 'Scanner signals' }

function SourceList({ sources, citations, openN, onOpen }) {
  const cited = new Set((citations || []).map((c) => c.n))
  return (
    <div className="flex flex-col gap-[2px] text-xs">
      {sources.map((s) => (
        <div key={s.n} className={`rounded border ${openN === s.n ? 'border-primary' : 'border-outline-variant'} px-sm py-[2px]`}>
          <button type="button" onClick={() => onOpen(openN === s.n ? null : s.n)} className="w-full text-left flex items-center gap-xs">
            <span className="font-mono text-primary">[{s.n}]</span>
            <span className={`truncate ${cited.has(s.n) ? 'text-on-surface' : 'text-on-surface-variant'}`}>{s.title}</span>
            <span className="text-on-surface-variant shrink-0">{s.reportDate || 'no date'} · p.{s.page}</span>
          </button>
          {openN === s.n && (
            <div className="pt-xs pb-xs text-on-surface-variant">
              {s.section && <div className="text-[11px] uppercase tracking-wide">{s.section}</div>}
              <p className="whitespace-pre-wrap">{s.snippet}{s.snippet?.length >= 240 ? '…' : ''}</p>
              <a href={documentDownloadUrl(s.docId)} className="text-primary hover:underline">Download file</a>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function AssistantMessage({ message }) {
  const [openN, setOpenN] = useState(null)
  const filterText = describeFilter(message.filter)
  return (
    <div className="flex flex-col gap-xs">
      {message.tools?.length > 0 && (
        <div className="flex flex-wrap gap-xs">
          {message.tools.map((t) => (
            <span key={t.id} title={`${t.name} ${JSON.stringify(t.args)}`} className="text-[11px] px-sm py-[1px] rounded-full border border-outline-variant text-on-surface-variant flex items-center gap-xs">
              {t.status === 'running' ? <Spinner /> : <span aria-hidden="true">{t.ok ? '✓' : '✕'}</span>}
              {TOOL_LABELS[t.name] || t.name}
              {t.summary && <span className="opacity-70">· {t.summary}</span>}
            </span>
          ))}
        </div>
      )}
      {filterText && <div className="text-[11px] text-on-surface-variant">Searched {filterText}</div>}
      {message.content ? <AnswerText text={message.content} sources={message.sources} onCite={setOpenN} /> : message.pending && !message.error ? <Spinner /> : null}
      {message.error && <div className="text-sm text-bearish">{message.error}</div>}
      {message.sources?.length > 0 && !message.pending && (
        <details className="text-xs text-on-surface-variant">
          <summary className="cursor-pointer select-none">Sources ({message.sources.length})</summary>
          <div className="pt-xs"><SourceList sources={message.sources} citations={message.citations} openN={openN} onOpen={setOpenN} /></div>
        </details>
      )}
      {openN != null && message.sources?.length > 0 && !message.pending && <div className="sr-only" aria-live="polite">Opened source {openN}</div>}
    </div>
  )
}

export default function ChatPanel({ scope, initialThreadId = null, defaultMode = 'rag', suggestions = [], onThreadChange, className = '', placeholder = 'Ask about your documents…' }) {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState(defaultMode)
  const [loadError, setLoadError] = useState('')
  const threadRef = useRef(initialThreadId)
  const abortRef = useRef(null)
  const endRef = useRef(null)
  const scopeRef = useRef(scope)
  scopeRef.current = scope

  useEffect(() => {
    if (!initialThreadId) return undefined
    let cancelled = false
    getChatMessages(initialThreadId)
      .then(({ messages: saved }) => {
        if (!cancelled) setMessages(saved.map((m) => ({ ...m, tools: m.toolCalls })))
      })
      .catch((err) => !cancelled && setLoadError(err?.response?.data?.error || err.message))
    return () => {
      cancelled = true
    }
  }, [initialThreadId])

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' })
  }, [messages])

  const patchLast = useCallback((fn) => setMessages((current) => current.map((m, i) => (i === current.length - 1 ? fn(m) : m))), [])

  const send = useCallback(
    async (text) => {
      const question = text.trim()
      if (!question || busy) return
      setInput('')
      setBusy(true)
      setMessages((current) => [...current, { role: 'user', content: question }, { role: 'assistant', content: '', pending: true, tools: [], sources: [] }])
      const controller = new AbortController()
      abortRef.current = controller
      try {
        await streamChat({ message: question, threadId: threadRef.current, mode, scope: scopeRef.current }, (event, data) => {
          if (event === 'thread') {
            threadRef.current = data.threadId
            onThreadChange?.(data.threadId)
          } else if (event === 'filter') patchLast((m) => ({ ...m, filter: data.filter }))
          else if (event === 'sources') patchLast((m) => ({ ...m, sources: data.sources }))
          else if (event === 'tool') patchLast((m) => ({ ...m, tools: m.tools.some((t) => t.id === data.id) ? m.tools.map((t) => (t.id === data.id ? { ...t, ...data } : t)) : [...m.tools, data] }))
          else if (event === 'reset') patchLast((m) => ({ ...m, content: '' }))
          else if (event === 'delta') patchLast((m) => ({ ...m, content: m.content + data.text }))
          else if (event === 'done') patchLast((m) => ({ ...m, pending: false, citations: data.citations, usage: data.usage }))
          else if (event === 'error') patchLast((m) => ({ ...m, pending: false, error: data.error }))
        }, controller.signal)
        patchLast((m) => ({ ...m, pending: false }))
      } catch (err) {
        patchLast((m) => ({ ...m, pending: false, error: err.name === 'AbortError' ? (m.content ? null : 'Stopped.') : err.message }))
      } finally {
        abortRef.current = null
        setBusy(false)
      }
    },
    [busy, mode, onThreadChange, patchLast]
  )

  return (
    <div className={`flex flex-col gap-sm min-h-0 ${className}`}>
      <div className="flex items-center gap-xs flex-wrap" role="group" aria-label="Answer mode">
        {MODES.map((m) => (
          <button
            key={m.key}
            type="button"
            title={m.hint}
            onClick={() => setMode(m.key)}
            disabled={busy}
            className={`px-md py-xs rounded-full text-xs border ${mode === m.key ? 'bg-primary-container text-on-primary-container border-transparent' : 'border-outline-variant text-on-surface-variant hover:text-on-surface'}`}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-[240px] overflow-y-auto flex flex-col gap-md pr-xs" aria-live="polite">
        {loadError && <div className="text-sm text-bearish">{loadError}</div>}
        {messages.length === 0 && !loadError && (
          <div className="text-sm text-on-surface-variant flex flex-col gap-xs">
            <p>Ask about the uploaded documents. Mention a date (“on 14 Nov 2025”, “last week”, “between 10 and 14 Nov”) to focus on those reports.</p>
            {suggestions.map((s) => (
              <button key={s} type="button" onClick={() => send(s)} className="text-left text-primary hover:underline">
                {s}
              </button>
            ))}
          </div>
        )}
        {messages.map((m, i) =>
          m.role === 'user' ? (
            <div key={i} className="self-end max-w-[85%] rounded-lg bg-surface-container-highest px-md py-sm text-sm whitespace-pre-wrap">{m.content}</div>
          ) : (
            <div key={i} className="max-w-[95%]"><AssistantMessage message={m} /></div>
          )
        )}
        <div ref={endRef} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          send(input)
        }}
        className="flex items-end gap-sm"
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send(input)
            }
          }}
          rows={2}
          maxLength={4000}
          placeholder={placeholder}
          aria-label="Your question"
          className="flex-1 bg-surface-container-low border border-terminal-border rounded-lg text-sm px-md py-sm text-on-surface resize-none"
        />
        {busy ? (
          <button type="button" onClick={() => abortRef.current?.abort()} className="px-md py-sm rounded-lg border border-outline-variant text-sm text-on-surface">
            Stop
          </button>
        ) : (
          <button type="submit" disabled={!input.trim()} className="px-md py-sm rounded-lg bg-primary-container text-on-primary-container text-sm font-medium disabled:opacity-50">
            Ask
          </button>
        )}
      </form>
    </div>
  )
}
