/**
 * Pieces shared by the two "+" popups (Option Chain and Report questions): the dialog frame, a labelled field,
 * and the clickable list of questions. The dialog is rendered into document.body: the chat panel has
 * overflow-hidden and a backdrop filter, which would otherwise clip a fixed-position dialog to the panel.
 */

import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import Spinner from '../Spinner'

export const fieldClass = 'w-full h-9 bg-surface-container-low border border-terminal-border rounded-lg text-sm px-md text-on-surface disabled:opacity-50'

export function Field({ label, children, hint }) {
  return (
    <label className="flex flex-col gap-[3px] min-w-0">
      <span className="text-[11px] uppercase tracking-wide text-on-surface-variant">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-on-surface-variant">{hint}</span>}
    </label>
  )
}

export function PickerShell({ title, description, onClose, children }) {
  const dialogRef = useRef(null)
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    dialogRef.current?.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-md" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className="glass-panel rounded-xl p-lg w-full max-w-2xl max-h-[90vh] overflow-y-auto flex flex-col gap-md bg-surface outline-none">
        <div className="flex items-start justify-between gap-md">
          <div>
            <h3 className="text-base font-semibold text-on-surface">{title}</h3>
            <p className="text-xs text-on-surface-variant">{description}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="text-on-surface-variant hover:text-on-surface">✕</button>
        </div>
        {children}
      </div>
    </div>,
    document.body
  )
}

/** The question bank failed to load, or is still loading. */
export function LoadState({ topics, loadError, onRetry }) {
  if (loadError) {
    return (
      <div className="text-sm text-bearish flex items-center gap-sm">
        {loadError}
        <button type="button" onClick={onRetry} className="px-sm py-xs rounded-lg border border-outline-variant text-on-surface text-xs">Retry</button>
      </div>
    )
  }
  return topics ? null : <div className="flex items-center gap-xs text-sm text-on-surface-variant"><Spinner />Loading questions…</div>
}

/** "Questions to analyse": clicking one calls onPick(question) - the caller copies it into the message box. */
export function QuestionList({ questions, onPick, emptyText, problem }) {
  return (
    <div className="flex flex-col gap-xs">
      <span className="text-[11px] uppercase tracking-wide text-on-surface-variant">Questions to analyse</span>
      {questions ? (
        <ul className="flex flex-col gap-xs" aria-label="Questions to analyse">
          {questions.map((q) => (
            <li key={q.id}>
              <button type="button" onClick={() => onPick(q)} className="w-full text-left rounded-lg border border-outline-variant bg-surface-container-low hover:bg-surface-container-highest px-md py-sm flex flex-col gap-[2px]">
                <span className="text-sm text-on-surface">{q.text}</span>
                {(q.signal || q.movement) && <span className="text-[11px] text-on-surface-variant">{[q.signal, q.movement && `→ ${q.movement}`].filter(Boolean).join(' · ')}</span>}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-on-surface-variant">{emptyText}</p>
      )}
      {problem && <p className="text-sm text-bearish" role="alert">{problem}</p>}
    </div>
  )
}
