/**
 * The "+" button of the chat box and its dialog: Topic -> Exact NSE report name -> Questions to analyse.
 * Clicking a question does NOT send it - it is copied into the text box (onPick) so the user can edit it
 * first. The Option Chain topic also asks for a symbol and an expiry date (the live Groww chain is fetched for
 * that), and any topic can set a word limit for the answer. The questions come from GET /question-bank.
 * The dialog is rendered into document.body: the chat panel has overflow-hidden and a backdrop filter, which
 * would otherwise clip a fixed-position dialog to the panel.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { getQuestionBank, getUnderlyingSymbols, errorText } from '../../services/api'
import Spinner from '../Spinner'
import { findReports, findQuestions, optionChainProblem, wordLimitProblem, pickedContext, OPTION_CHAIN_TOPIC, WORD_LIMIT_RANGE } from './questionBank'

const fieldClass = 'w-full h-9 bg-surface-container-low border border-terminal-border rounded-lg text-sm px-md text-on-surface disabled:opacity-50'

function Field({ label, children }) {
  return (
    <label className="flex flex-col gap-[3px] min-w-0">
      <span className="text-[11px] uppercase tracking-wide text-on-surface-variant">{label}</span>
      {children}
    </label>
  )
}

/** current = the context already on the chat ({ optionChain, wordLimit }), used to pre-fill the fields. */
export default function QuestionPicker({ current, onPick, disabled }) {
  const [open, setOpen] = useState(false)
  const [topics, setTopics] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [symbols, setSymbols] = useState([])
  const [topic, setTopic] = useState('')
  const [report, setReport] = useState('')
  const [symbol, setSymbol] = useState('')
  const [expiryDate, setExpiryDate] = useState('')
  const [wordLimit, setWordLimit] = useState('')
  const [problem, setProblem] = useState('')
  const dialogRef = useRef(null)

  const load = () => {
    setLoadError('')
    getQuestionBank().then(setTopics).catch((err) => setLoadError(errorText(err)))
  }

  const openPicker = () => {
    setSymbol(current?.optionChain?.symbol ?? '')
    setExpiryDate(current?.optionChain?.expiryDate ?? '')
    setWordLimit(current?.wordLimit ? String(current.wordLimit) : '')
    setProblem('')
    setOpen(true)
    if (!topics) load()
  }

  // The symbol list is only needed for Option Chain questions; fetched once, and a failure just leaves a plain text box.
  useEffect(() => {
    if (topic !== OPTION_CHAIN_TOPIC || symbols.length) return
    getUnderlyingSymbols().then((r) => setSymbols(r.symbols ?? [])).catch(() => {})
  }, [topic, symbols.length])

  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('keydown', onKey)
    dialogRef.current?.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  const reports = useMemo(() => findReports(topics, topic), [topics, topic])
  const questions = useMemo(() => findQuestions(topics, topic, report), [topics, topic, report])
  const isOptionChain = topic === OPTION_CHAIN_TOPIC

  const chooseTopic = (value) => {
    setTopic(value)
    setProblem('')
    const list = findReports(topics, value)
    setReport(list.length === 1 ? list[0].report : '') // a topic with one report needs no second choice
  }

  const pick = (question) => {
    const why = isOptionChain ? optionChainProblem({ symbol, expiryDate, wordLimit }) : wordLimitProblem(wordLimit)
    if (why) return setProblem(why)
    onPick(question.text, pickedContext({ topic, symbol, expiryDate, wordLimit }))
    setOpen(false)
  }

  return (
    <>
      <button type="button" onClick={openPicker} disabled={disabled} title="Pick a standard question (topic, NSE report, question)" aria-label="Pick a standard question" aria-haspopup="dialog" className="p-sm rounded-lg text-on-surface-variant hover:bg-surface-container-highest disabled:opacity-50">
        <span className="material-symbols-outlined">add</span>
      </button>
      {open && createPortal(
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-md" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
          <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Pick a standard question" className="glass-panel rounded-xl p-lg w-full max-w-2xl max-h-[90vh] overflow-y-auto flex flex-col gap-md bg-surface outline-none">
            <div className="flex items-start justify-between gap-md">
              <div>
                <h3 className="text-base font-semibold text-on-surface">Standard questions</h3>
                <p className="text-xs text-on-surface-variant">Pick a topic and an NSE report, then a question. It is copied into the message box — edit it, then send.</p>
              </div>
              <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="text-on-surface-variant hover:text-on-surface">✕</button>
            </div>

            {loadError && (
              <div className="text-sm text-bearish flex items-center gap-sm">
                {loadError}
                <button type="button" onClick={load} className="px-sm py-xs rounded-lg border border-outline-variant text-on-surface text-xs">Retry</button>
              </div>
            )}
            {!topics && !loadError && <div className="flex items-center gap-xs text-sm text-on-surface-variant"><Spinner />Loading questions…</div>}

            {topics && (
              <>
                <div className="grid gap-md sm:grid-cols-2">
                  <Field label="Topic">
                    <select value={topic} onChange={(e) => chooseTopic(e.target.value)} className={fieldClass} aria-label="Topic">
                      <option value="">Select a topic</option>
                      {topics.map((t) => <option key={t.topic} value={t.topic}>{t.topic}</option>)}
                    </select>
                  </Field>
                  <Field label="Exact NSE report name">
                    <select value={report} onChange={(e) => setReport(e.target.value)} disabled={!topic} className={fieldClass} aria-label="Exact NSE report name">
                      <option value="">{topic ? 'Select a report' : 'Select a topic first'}</option>
                      {reports.map((r) => <option key={r.report} value={r.report}>{r.report}</option>)}
                    </select>
                  </Field>
                </div>

                {isOptionChain && (
                  <div className="grid gap-md sm:grid-cols-2">
                    <Field label="Symbol">
                      <input list="qp-symbols" value={symbol} onChange={(e) => { setSymbol(e.target.value.toUpperCase()); setProblem('') }} placeholder="e.g. NIFTY" className={fieldClass} aria-label="Option chain symbol" />
                      <datalist id="qp-symbols">{symbols.map((s) => <option key={s} value={s} />)}</datalist>
                    </Field>
                    <Field label="Expiry date">
                      <input type="date" value={expiryDate} onChange={(e) => { setExpiryDate(e.target.value); setProblem('') }} className={fieldClass} aria-label="Option chain expiry date" />
                    </Field>
                  </div>
                )}
                {topic && (
                  <div className="max-w-[240px]">
                    <Field label="Word limit (optional)">
                      <input type="number" min={WORD_LIMIT_RANGE[0]} max={WORD_LIMIT_RANGE[1]} value={wordLimit} onChange={(e) => { setWordLimit(e.target.value); setProblem('') }} placeholder={`${WORD_LIMIT_RANGE[0]}–${WORD_LIMIT_RANGE[1]} words`} className={fieldClass} aria-label="Word limit" />
                    </Field>
                  </div>
                )}

                <div className="flex flex-col gap-xs">
                  <span className="text-[11px] uppercase tracking-wide text-on-surface-variant">Questions to analyse</span>
                  {!report ? (
                    <p className="text-sm text-on-surface-variant">{topic ? 'Select a report to see its questions.' : 'Select a topic and a report to see the questions.'}</p>
                  ) : (
                    <ul className="flex flex-col gap-xs">
                      {questions.map((q) => (
                        <li key={q.id}>
                          <button type="button" onClick={() => pick(q)} className="w-full text-left rounded-lg border border-outline-variant bg-surface-container-low hover:bg-surface-container-highest px-md py-sm flex flex-col gap-[2px]">
                            <span className="text-sm text-on-surface">{q.text}</span>
                            {(q.signal || q.movement) && (
                              <span className="text-[11px] text-on-surface-variant">{[q.signal, q.movement && `→ ${q.movement}`].filter(Boolean).join(' · ')}</span>
                            )}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {problem && <p className="text-sm text-bearish" role="alert">{problem}</p>}
                </div>
              </>
            )}
          </div>
        </div>,
        document.body
      )}
    </>
  )
}
