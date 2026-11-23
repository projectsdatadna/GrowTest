/**
 * Compare the current (default: latest) FII report with any other report date. The table of changes is
 * computed by the server from the extracted figures; the AI summary explains it. Results are cached
 * per pair of reports, so reopening is instant - "Re-run" forces a fresh analysis.
 */

import { useCallback, useEffect, useState } from 'react'
import { getFiiDates, compareFiiReports } from '../../services/api'
import Spinner from '../Spinner'

const selectClass = 'bg-surface-container-low border border-terminal-border rounded-lg text-sm px-md py-xs text-on-surface'
const SHIFT = {
  more_bullish: { label: 'More bullish', className: 'text-bullish' },
  more_bearish: { label: 'More bearish', className: 'text-bearish' },
  unchanged: { label: 'Unchanged', className: 'text-on-surface-variant' },
  mixed: { label: 'Mixed', className: 'text-on-surface-variant' },
}
const fmt = (n) => (n == null ? '—' : n.toLocaleString('en-IN', { maximumFractionDigits: 2 }))

function DeltaTable({ deltas, currentDate, previousDate }) {
  if (!deltas.length) return <p className="text-sm text-on-surface-variant">No structured figures could be extracted from these reports, so there is no table - see the summary below.</p>
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="text-[11px] uppercase tracking-wide text-on-surface-variant">
          <tr>
            <th className="text-left pb-xs font-normal">Metric</th>
            <th className="text-right pb-xs font-normal">{previousDate}</th>
            <th className="text-right pb-xs font-normal">{currentDate}</th>
            <th className="text-right pb-xs font-normal">Change</th>
            <th className="text-right pb-xs font-normal">%</th>
          </tr>
        </thead>
        <tbody>
          {deltas.map((d) => (
            <tr key={d.key} className="border-t border-outline-variant">
              <td className="py-xs text-on-surface">
                {d.label} <span className="text-on-surface-variant">({d.unit})</span>
                {!d.verified && <span title="This figure was not found verbatim in the report text - check the source" className="ml-xs text-[10px] px-xs rounded border border-outline-variant text-on-surface-variant">unverified</span>}
              </td>
              <td className="py-xs text-right font-mono">{fmt(d.previous)}</td>
              <td className="py-xs text-right font-mono">{fmt(d.current)}</td>
              <td className={`py-xs text-right font-mono ${d.direction === 'up' ? 'text-bullish' : d.direction === 'down' ? 'text-bearish' : ''}`}>{d.delta == null ? '—' : `${d.delta > 0 ? '+' : ''}${fmt(d.delta)}`}</td>
              <td className="py-xs text-right font-mono text-on-surface-variant">{d.deltaPct == null ? '—' : `${d.deltaPct > 0 ? '+' : ''}${fmt(d.deltaPct)}%`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function ComparePanel({ refreshKey = 0 }) {
  const [dates, setDates] = useState(null)
  const [current, setCurrent] = useState('')
  const [previous, setPrevious] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    getFiiDates()
      .then((r) => {
        if (cancelled) return
        setDates(r.dates)
        setCurrent((c) => (r.dates.some((d) => d.date === c) ? c : r.dates[0]?.date || ''))
        setPrevious((p) => (r.dates.some((d) => d.date === p) ? p : r.dates[1]?.date || ''))
      })
      .catch((err) => !cancelled && setError(err?.response?.data?.error || err.message))
    return () => {
      cancelled = true
    }
  }, [refreshKey])

  const run = useCallback(
    async (force) => {
      setBusy(true)
      setError('')
      setResult(null)
      try {
        setResult(await compareFiiReports({ currentDate: current, compareDate: previous, force }))
      } catch (err) {
        setError(err?.response?.data?.error || err.message)
      } finally {
        setBusy(false)
      }
    },
    [current, previous]
  )

  if (error && !dates) return <div className="text-sm text-bearish">{error}</div>
  if (!dates) return <Spinner />
  if (dates.length < 2) return <p className="text-sm text-on-surface-variant">Upload at least two FII reports with different report dates to compare them. {dates.length === 1 ? `You have one (${dates[0].date}).` : ''}</p>

  const analysis = result?.status === 'SUCCESS' ? result.analysis : null
  const shift = analysis?.positioning_shift
  const shiftStyle = SHIFT[shift?.direction] || SHIFT.mixed

  return (
    <div className="flex flex-col gap-md">
      <div className="flex items-end gap-md flex-wrap">
        <label className="flex flex-col gap-[2px] text-xs text-on-surface-variant">
          Current report
          <select value={current} onChange={(e) => setCurrent(e.target.value)} className={selectClass}>
            {dates.map((d) => <option key={d.date} value={d.date}>{d.date} · {d.title}</option>)}
          </select>
        </label>
        <span className="pb-xs text-on-surface-variant">vs</span>
        <label className="flex flex-col gap-[2px] text-xs text-on-surface-variant">
          Compare with
          <select value={previous} onChange={(e) => setPrevious(e.target.value)} className={selectClass}>
            {dates.filter((d) => d.date !== current).map((d) => <option key={d.date} value={d.date}>{d.date} · {d.title}</option>)}
          </select>
        </label>
        <button type="button" onClick={() => run(false)} disabled={busy || !current || !previous || current === previous} className="px-md py-sm rounded-lg bg-primary-container text-on-primary-container text-sm font-medium disabled:opacity-50 flex items-center gap-xs">
          {busy && <Spinner />}Compare
        </button>
      </div>

      {error && <div className="text-sm text-bearish">{error}</div>}
      {result?.status === 'MISSING_DATE' && (
        <div className="text-sm text-on-surface-variant">No report for {result.date}. Available dates: {result.available.join(', ') || 'none'}.</div>
      )}

      {analysis && (
        <div className="flex flex-col gap-md">
          <div className="glass-panel rounded-xl p-md flex flex-col gap-xs">
            <div className="flex items-center gap-sm flex-wrap">
              <h3 className="text-base font-semibold text-on-surface">{analysis.headline}</h3>
              {shift && <span className={`text-xs px-sm py-[1px] rounded-full border border-outline-variant ${shiftStyle.className}`}>{shiftStyle.label}</span>}
              <span className="ml-auto text-[11px] text-on-surface-variant flex items-center gap-sm">
                {result.cached ? 'Saved result' : 'Fresh analysis'}
                <button type="button" onClick={() => run(true)} disabled={busy} className="text-primary hover:underline">Re-run</button>
              </span>
            </div>
            {shift?.explanation && <p className="text-sm text-on-surface-variant">{shift.explanation}</p>}
          </div>

          <div className="glass-panel rounded-xl p-md">
            <h4 className="text-sm font-semibold text-on-surface pb-xs">What changed</h4>
            <DeltaTable deltas={result.deltas} currentDate={result.current.reportDate} previousDate={result.previous.reportDate} />
          </div>

          {analysis.key_changes?.length > 0 && (
            <div className="glass-panel rounded-xl p-md flex flex-col gap-xs">
              <h4 className="text-sm font-semibold text-on-surface">Key changes</h4>
              <ul className="flex flex-col gap-xs text-sm">
                {analysis.key_changes.map((c, i) => (
                  <li key={i}><span className="text-on-surface">{c.metric}:</span> <span className="text-on-surface-variant">{c.change}</span>{c.why_it_matters && <span className="text-on-surface-variant"> — {c.why_it_matters}</span>}</li>
                ))}
              </ul>
            </div>
          )}
          {analysis.other_observations?.length > 0 && (
            <div className="glass-panel rounded-xl p-md text-sm">
              <h4 className="font-semibold text-on-surface pb-xs">Other observations</h4>
              <ul className="list-disc pl-lg text-on-surface-variant">{analysis.other_observations.map((o, i) => <li key={i}>{o}</li>)}</ul>
            </div>
          )}
          {(analysis.caveats?.length > 0 || result.warnings?.length > 0) && (
            <div className="text-xs text-on-surface-variant">
              <div className="uppercase tracking-wide text-[11px]">Caveats</div>
              <ul className="list-disc pl-lg">{[...(analysis.caveats || []), ...(result.warnings || [])].map((c, i) => <li key={i}>{c}</li>)}</ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
