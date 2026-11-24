/**
 * Notifications tab: the ₹ Stoploss and ₹ Target (profit) amounts the suggested
 * Stoploss / Target columns on every card are computed from, plus the upload of
 * the symbol sheet (SYMBOL | Margin | Price | Lot Size) that supplies lot size,
 * margin and a fallback price. The amounts persist in localStorage (per browser).
 */

import { useCallback, useEffect, useState } from 'react'
import { importSymbolSheet } from '../services/api'
import { parseAmount } from './stopTargetCalc'
import Spinner from './Spinner'

const STORAGE_KEY = 'growtest.stopTargetAmounts'

function readSaved() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    return { sl: String(saved.sl ?? ''), target: String(saved.target ?? '') }
  } catch {
    return { sl: '', target: '' }
  }
}

/** { slInput, targetInput, setSlInput, setTargetInput, slAmount, targetAmount } - amounts are numbers or null. */
export function useStopTargetAmounts() {
  const [inputs, setInputs] = useState(readSaved)
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ sl: inputs.sl, target: inputs.target }))
    } catch {
      // storage blocked - the amounts just do not survive a refresh
    }
  }, [inputs])
  return {
    slInput: inputs.sl,
    targetInput: inputs.target,
    setSlInput: (sl) => setInputs((current) => ({ ...current, sl })),
    setTargetInput: (target) => setInputs((current) => ({ ...current, target })),
    clear: () => setInputs({ sl: '', target: '' }),
    slAmount: parseAmount(inputs.sl),
    targetAmount: parseAmount(inputs.target),
  }
}

const listNames = (names, max = 12) => `${names.slice(0, max).join(', ')}${names.length > max ? ` +${names.length - max} more` : ''}`

/** One line for the notice after an import: which scanner symbols still have no lot size. */
export function missingLotSizeText(missing) {
  if (!missing) return ''
  const parts = []
  if (missing.stocks.length) parts.push(`stocks not in the sheet: ${listNames(missing.stocks, 8)}`)
  if (missing.indices.length) parts.push(`${missing.indices.length} ${missing.indices.length === 1 ? 'index' : 'indices'} without futures`)
  return parts.length ? `Still no lot size - ${parts.join('; ')}.` : ''
}

function MissingLotSizes({ missing }) {
  if (!missing || (!missing.stocks.length && !missing.indices.length)) return null
  return (
    <div className="pt-xs flex flex-col gap-[2px]">
      {missing.stocks.length > 0 && (
        <div title={missing.stocks.join(', ')}>
          <span className="text-on-surface">Still no lot size ({missing.stocks.length} stock{missing.stocks.length === 1 ? '' : 's'} - add to the sheet):</span> {listNames(missing.stocks)}
        </div>
      )}
      {missing.indices.length > 0 && (
        <div title={missing.indices.join(', ')}>
          {missing.indices.length} {missing.indices.length === 1 ? 'index has' : 'indices have'} no lot size (no futures): {listNames(missing.indices, 6)}
        </div>
      )}
    </div>
  )
}

function ImportDialog({ onClose, onImported }) {
  const [file, setFile] = useState(null)
  const [overwrite, setOverwrite] = useState(true)
  const [preview, setPreview] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const run = async (dryRun) => {
    setBusy(true)
    setError('')
    try {
      const result = await importSymbolSheet(file, { overwrite, dryRun })
      if (dryRun) setPreview(result)
      else onImported(result)
    } catch (err) {
      setError(err?.response?.data?.error || err?.message || 'Import failed')
    } finally {
      setBusy(false)
    }
  }

  const onPick = (event) => {
    setFile(event.target.files?.[0] || null)
    setPreview(null)
    setError('')
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-md" role="dialog" aria-modal="true" aria-label="Import lot size sheet">
      <div className="glass-panel rounded-xl p-lg w-full max-w-md flex flex-col gap-md">
        <h3 className="text-base font-semibold text-on-surface">Import lot size / margin sheet</h3>
        <p className="text-xs text-on-surface-variant">
          An .xlsx with the columns <b>SYMBOL, Margin, Price, Lot Size</b> (any sheet, any column order). Lot size and price are refreshed; the margin is the NRML margin shown on the cards.
        </p>
        <input type="file" accept=".xlsx" onChange={onPick} className="text-sm text-on-surface" aria-label="Symbol sheet file" />
        <label className="flex items-center gap-xs text-xs text-on-surface-variant">
          <input type="checkbox" checked={overwrite} onChange={(e) => { setOverwrite(e.target.checked); setPreview(null) }} />
          Replace margins already saved (otherwise only symbols without one are filled)
        </label>
        {preview && (
          <div className="text-xs text-on-surface-variant flex flex-col gap-[2px]" aria-live="polite">
            <div className="text-on-surface">
              {preview.rowsInSheet} rows in “{preview.sheetName}” · {preview.matched} match scanner symbols · {preview.changed} would change
            </div>
            {preview.keptExistingMargin.length > 0 && <div>Existing margin kept for {preview.keptExistingMargin.length} symbol(s).</div>}
            {preview.unmatched.length > 0 && <div title={preview.unmatched.join(', ')}>Not in the scanner (skipped): {preview.unmatched.slice(0, 12).join(', ')}{preview.unmatched.length > 12 ? ` +${preview.unmatched.length - 12} more` : ''}</div>}
            <MissingLotSizes missing={preview.scannerWithoutLotSize} />
          </div>
        )}
        {error && <div className="text-sm text-bearish">{error}</div>}
        <div className="flex justify-end gap-sm">
          <button type="button" onClick={onClose} disabled={busy} className="px-md py-sm rounded-lg text-sm border border-outline-variant text-on-surface-variant">
            Cancel
          </button>
          <button type="button" onClick={() => run(true)} disabled={busy || !file} className="px-md py-sm rounded-lg text-sm border border-outline-variant text-on-surface disabled:opacity-50">
            Preview
          </button>
          <button type="button" onClick={() => run(false)} disabled={busy || !file || !preview || preview.changed === 0} className="px-md py-sm rounded-lg text-sm font-medium bg-primary-container text-on-primary-container disabled:opacity-50 flex items-center gap-xs">
            {busy && <Spinner />}
            Import
          </button>
        </div>
      </div>
    </div>
  )
}

export default function StopTargetControls({ amounts, inputClass, onImported }) {
  const [showImport, setShowImport] = useState(false)
  const handleImported = useCallback(
    (result) => {
      setShowImport(false)
      onImported?.(result)
    },
    [onImported]
  )
  const empty = !amounts.slInput && !amounts.targetInput
  return (
    <>
      <div className="flex items-center gap-sm flex-wrap rounded-lg border border-outline-variant px-sm py-xs ml-md" role="group" aria-label="Suggested Stoploss / Target">
        <span className="text-[11px] uppercase tracking-wide text-on-surface-variant">Suggested SL / Target</span>
        <label className="flex items-center gap-xs text-xs text-on-surface-variant" title="Stoploss amount in ₹ for one lot - Stoploss = ₹ ÷ lot size">
          Stoploss ₹
          <input type="text" inputMode="decimal" value={amounts.slInput} onChange={(e) => amounts.setSlInput(e.target.value)} placeholder="e.g. 7500" className={`${inputClass} w-24`} aria-label="Stoploss amount in rupees" />
        </label>
        <label className="flex items-center gap-xs text-xs text-on-surface-variant" title="Profit target in ₹ for one lot - Target = ₹ ÷ lot size">
          Target ₹
          <input type="text" inputMode="decimal" value={amounts.targetInput} onChange={(e) => amounts.setTargetInput(e.target.value)} placeholder="e.g. 17000" className={`${inputClass} w-24`} aria-label="Target amount in rupees" />
        </label>
        {!empty && (
          <button type="button" onClick={amounts.clear} className="text-xs text-primary hover:underline">
            Clear
          </button>
        )}
        <button type="button" onClick={() => setShowImport(true)} className="px-md py-xs rounded-lg border border-outline-variant text-xs text-on-surface-variant hover:text-on-surface flex items-center gap-xs" title="Upload the SYMBOL / Margin / Price / Lot Size sheet">
          <span className="material-symbols-outlined text-[16px]">upload_file</span>
          Lot size sheet
        </button>
        {empty && <span className="text-[11px] text-on-surface-variant" role="note">Enter Stoploss ₹ and Target ₹ to add a suggested SL / Target column to every card.</span>}
      </div>
      {showImport && <ImportDialog onClose={() => setShowImport(false)} onImported={handleImported} />}
    </>
  )
}
