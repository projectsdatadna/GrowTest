/**
 * The Option Chain popup: where the data comes from (live Groww chain, or a saved 15-minute snapshot of a past
 * date and time), the symbol, what to compare it with, an optional word limit - then the Option Chain question.
 * Clicking a question copies it into the message box (it is never sent); the data itself is fetched by the
 * server when the question is sent, so nothing has to be attached.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { getQuestionBank, getUnderlyingSymbols, getOptionChainSymbols, getOptionChainSlots, errorText } from '../../services/api'
import Spinner from '../Spinner'
import { PickerShell, Field, fieldClass, LoadState, QuestionList } from './pickerParts'
import { findReports, optionChainProblem, pickedContext, dateLabel, COMPARE_OPTIONS, OPTION_CHAIN_TOPIC, WORD_LIMIT_RANGE } from './questionBank'

/** current = the context already on the chat ({ optionChain, wordLimit }), used to pre-fill the fields. */
export default function OptionChainPicker({ current, onPick, onClose }) {
  const oc = current?.optionChain
  const [topics, setTopics] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [source, setSource] = useState(oc?.asOf ? 'saved' : 'live')
  const [liveSymbols, setLiveSymbols] = useState([])
  const [saved, setSaved] = useState(null) // { symbols, earliestDate, latestDate }
  const [symbol, setSymbol] = useState(oc?.symbol ?? '')
  const [expiryDate, setExpiryDate] = useState(oc?.expiryDate ?? '')
  const [date, setDate] = useState(oc?.asOf?.date ?? '')
  const [time, setTime] = useState(oc?.asOf?.time ?? '')
  const [slots, setSlots] = useState(null) // null = not asked / loading
  const [slotError, setSlotError] = useState('')
  const [compareWith, setCompareWith] = useState(oc?.compareWith ?? (oc?.asOf ? '15m' : ''))
  const [wordLimit, setWordLimit] = useState(current?.wordLimit ? String(current.wordLimit) : '')
  const [problem, setProblem] = useState('')

  const load = useCallback(() => {
    setLoadError('')
    getQuestionBank().then(setTopics).catch((err) => setLoadError(errorText(err)))
  }, [])
  useEffect(load, [load])
  // The symbol lists are only suggestions: a failure just leaves a plain text box.
  useEffect(() => {
    getUnderlyingSymbols().then((r) => setLiveSymbols(r.symbols ?? [])).catch(() => {})
    getOptionChainSymbols().then(setSaved).catch(() => {})
  }, [])

  // The snapshot times that exist for this symbol on this day.
  useEffect(() => {
    if (source !== 'saved' || !symbol.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setSlots(null)
      return undefined
    }
    let cancelled = false
    setSlots(null)
    setSlotError('')
    getOptionChainSlots(symbol.trim().toUpperCase(), date)
      .then((list) => {
        if (cancelled) return
        setSlots(list)
        setTime((t) => (list.some((s) => s.time === t) ? t : ''))
      })
      .catch((err) => !cancelled && (setSlotError(errorText(err)), setSlots([])))
    return () => {
      cancelled = true
    }
  }, [source, symbol, date])

  const questions = useMemo(() => findReports(topics, OPTION_CHAIN_TOPIC).flatMap((r) => r.questions), [topics])

  const chooseSource = (value) => {
    setSource(value)
    setProblem('')
    setCompareWith((c) => (value === 'saved' ? c || '15m' : c)) // a saved snapshot is always compared with an earlier one
  }
  const touch = (setter) => (value) => {
    setter(value)
    setProblem('')
  }

  const pick = (question) => {
    const fields = { source, symbol, expiryDate, date, time, compareWith, wordLimit }
    const why = optionChainProblem(fields)
    if (why) return setProblem(why)
    onPick(question.text, pickedContext({ topic: OPTION_CHAIN_TOPIC, ...fields }), [])
    onClose()
  }

  const suggestions = source === 'saved' ? saved?.symbols ?? [] : liveSymbols
  const noSnapshots = source === 'saved' && slots && slots.length === 0 && !slotError
  return (
    <PickerShell title="Option Chain questions" description="Choose the data, then a question. The question is copied into the message box — edit it, then send. The option chain is fetched when you send." onClose={onClose}>
      <LoadState topics={topics} loadError={loadError} onRetry={load} />
      <div className="grid gap-md sm:grid-cols-2">
        <Field label="Topic">
          <input value={OPTION_CHAIN_TOPIC} readOnly className={fieldClass} aria-label="Topic" />
        </Field>
        <Field label="Exact NSE report name">
          <input value={OPTION_CHAIN_TOPIC} readOnly className={fieldClass} aria-label="Exact NSE report name" />
        </Field>
      </div>

      <div className="grid gap-md sm:grid-cols-2">
        <Field label="Data">
          <select value={source} onChange={(e) => chooseSource(e.target.value)} className={fieldClass} aria-label="Data source">
            <option value="live">Live now (Groww)</option>
            <option value="saved">Saved snapshot (past date and time)</option>
          </select>
        </Field>
        <Field label="Symbol">
          <input list="oc-symbols" value={symbol} onChange={(e) => touch(setSymbol)(e.target.value.toUpperCase())} placeholder="e.g. NIFTY" className={fieldClass} aria-label="Option chain symbol" />
          <datalist id="oc-symbols">{suggestions.map((s) => <option key={s} value={s} />)}</datalist>
        </Field>
      </div>

      {source === 'live' ? (
        <div className="grid gap-md sm:grid-cols-2">
          <Field label="Expiry date">
            <input type="date" value={expiryDate} onChange={(e) => touch(setExpiryDate)(e.target.value)} className={fieldClass} aria-label="Option chain expiry date" />
          </Field>
          <Field label="Compare with">
            <select value={compareWith} onChange={(e) => setCompareWith(e.target.value)} className={fieldClass} aria-label="Compare with">
              <option value="">Latest saved snapshot</option>
              {COMPARE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label} earlier</option>)}
            </select>
          </Field>
        </div>
      ) : (
        <>
          <div className="grid gap-md sm:grid-cols-[1fr_1.5fr_1fr]">
            <Field label="Date" hint={saved?.earliestDate ? `Saved from ${dateLabel(saved.earliestDate)}` : undefined}>
              <input type="date" value={date} min={saved?.earliestDate || undefined} max={saved?.latestDate || undefined} onChange={(e) => touch(setDate)(e.target.value)} className={fieldClass} aria-label="Snapshot date" />
            </Field>
            <Field label="Snapshot time (IST)">
              <select value={time} onChange={(e) => touch(setTime)(e.target.value)} disabled={!slots?.length} className={fieldClass} aria-label="Snapshot time">
                <option value="">{slots?.length ? 'Select a time' : 'Pick a symbol and date'}</option>
                {(slots ?? []).map((s) => <option key={s.time} value={s.time}>{s.time}{s.expiry ? ` · exp ${s.expiry}` : ''}</option>)}
              </select>
            </Field>
            <Field label="Compare with">
              <select value={compareWith} onChange={(e) => setCompareWith(e.target.value)} className={fieldClass} aria-label="Compare with">
                {COMPARE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label} earlier</option>)}
              </select>
            </Field>
          </div>
          {symbol.trim() && /^\d{4}-\d{2}-\d{2}$/.test(date) && slots === null && !slotError && <div className="flex items-center gap-xs text-xs text-on-surface-variant"><Spinner />Looking for saved snapshots…</div>}
          {noSnapshots && <p className="text-xs text-bearish" role="status">No saved snapshots for {symbol.trim().toUpperCase()} on {dateLabel(date)}. They exist for the scanner's symbols on trading days since {saved?.earliestDate ? dateLabel(saved.earliestDate) : 'the scheduler started'}.</p>}
          {slotError && <p className="text-xs text-bearish" role="alert">{slotError}</p>}
          <p className="text-[11px] text-on-surface-variant">Saved snapshots are taken every 15 minutes (09:15–15:30) for the nearest expiry only, and have no volume.</p>
        </>
      )}

      <div className="max-w-[240px]">
        <Field label="Word limit (optional)">
          <input type="number" min={WORD_LIMIT_RANGE[0]} max={WORD_LIMIT_RANGE[1]} value={wordLimit} onChange={(e) => touch(setWordLimit)(e.target.value)} placeholder={`${WORD_LIMIT_RANGE[0]}–${WORD_LIMIT_RANGE[1]} words`} className={fieldClass} aria-label="Word limit" />
        </Field>
      </div>

      <QuestionList questions={topics ? questions : null} onPick={pick} emptyText="Loading the questions…" problem={problem} />
    </PickerShell>
  )
}
