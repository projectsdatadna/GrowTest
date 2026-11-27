/**
 * The lot size on a Notifications card, editable in place. Click the number (or "Set lot size" when there is
 * none), type a whole number, Enter or click away to save, Esc to cancel; saving an empty box resets a value
 * you typed back to the sheet / built-in one. The value is saved for everyone (Firestore) and every card of that
 * symbol updates at once. Clicks here never mark the card read.
 */

import { useRef, useState } from 'react'
import { saveCrossoverSymbolLotSize } from '../services/api'
import { parseLotSize } from './stopTargetCalc'
import Spinner from './Spinner'

const SOURCE_TAG = {
  user: { text: 'edited', title: 'Typed by you and saved for everyone. Save an empty box to go back to the sheet / built-in value.' },
  verify: { text: 'verify', title: 'This symbol is not in the lot size sheet; the value comes from the Groww instrument file (Feb 2026). Check it and edit it if the exchange changed it.' },
}

export default function LotSizeEditor({ group, lotSize, source, onSaved, emptyLabel = 'Set lot size' }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const skipBlur = useRef(false)

  const start = (event) => {
    event.stopPropagation()
    skipBlur.current = false
    setText(lotSize ? String(lotSize) : '')
    setError('')
    setEditing(true)
  }

  const save = async () => {
    if (busy) return
    const parsed = parseLotSize(text)
    if (parsed.error) return setError(parsed.error)
    // Nothing to do: unchanged, or an empty box where there is no typed value to reset.
    if (parsed.value === (lotSize ?? null) || (parsed.value === null && source !== 'user')) return setEditing(false)
    setBusy(true)
    setError('')
    try {
      const result = await saveCrossoverSymbolLotSize(`${group.exchange}_${group.symbol}`, parsed.value)
      onSaved?.(group.symbol, result)
      setEditing(false)
    } catch (err) {
      setError(err?.response?.data?.error || err?.message || 'Could not save')
    } finally {
      setBusy(false)
    }
  }

  if (editing) {
    return (
      <span className="inline-flex flex-col items-end gap-[2px]" onClick={(e) => e.stopPropagation()}>
        <span className="inline-flex items-center gap-xs">
          {busy && <Spinner />}
          <input
            autoFocus
            inputMode="numeric"
            value={text}
            disabled={busy}
            aria-label={`Lot size of ${group.symbol}`}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                save()
              } else if (e.key === 'Escape') {
                skipBlur.current = true
                setEditing(false)
              }
            }}
            onBlur={() => (skipBlur.current ? (skipBlur.current = false) : save())}
            className="w-[76px] bg-surface-container border border-primary rounded px-xs py-[1px] text-[11px] font-mono text-on-surface text-right"
          />
        </span>
        {source === 'user' && !error && <span className="text-[10px] text-on-surface-variant">empty = reset</span>}
        {error && <span role="alert" className="text-[10px] text-bearish max-w-[160px] text-right">{error}</span>}
      </span>
    )
  }

  if (lotSize == null) {
    return (
      <button type="button" onClick={start} className="text-[11px] text-primary hover:underline" title={`Type the lot size of ${group.symbol} - saved for everyone`}>
        {emptyLabel}
      </button>
    )
  }

  const tag = SOURCE_TAG[source]
  return (
    <span className="inline-flex items-baseline gap-xs">
      {tag && <span title={tag.title} className={`text-[9px] uppercase tracking-wide px-[3px] rounded border ${source === 'verify' ? 'border-amber-400/60 text-amber-400' : 'border-outline-variant text-on-surface-variant'}`}>{tag.text}</span>}
      <button type="button" onClick={start} className="group inline-flex items-center gap-[2px] font-mono text-on-surface hover:text-primary" title="Click to edit the lot size">
        {lotSize.toLocaleString('en-IN')}
        <span className="material-symbols-outlined text-[12px] opacity-40 group-hover:opacity-100" aria-hidden="true">edit</span>
      </button>
    </span>
  )
}
