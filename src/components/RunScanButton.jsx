/**
 * "Run now" - runs the crossover scanner immediately instead of waiting for
 * the scheduled tick (every 15 minutes, 09:15-15:15). Each request is a
 * bounded pass (the deployed API times out at 120s); while the server reports
 * `remaining` work and the last pass made progress, it runs another pass.
 */

import { useState } from 'react'
import { runCrossoverScan } from '../services/api'
import Spinner from './Spinner'

const MAX_PASSES = 10

export function describeRun(summary) {
  if (summary.due === 0) return 'Everything is up to date - no new bars to scan yet.'
  const parts = [`Scanned ${summary.scanned}`, `${summary.newAlerts} new alert${summary.newAlerts === 1 ? '' : 's'}`]
  if (summary.notPublished) parts.push(`${summary.notPublished} bar${summary.notPublished === 1 ? '' : 's'} not published yet`)
  if (summary.errors) parts.push(`${summary.errors} error${summary.errors === 1 ? '' : 's'}`)
  if (summary.remaining) parts.push(`${summary.remaining} still due (next tick picks them up)`)
  return parts.join(' · ')
}

export default function RunScanButton({ onDone, className = '' }) {
  const [running, setRunning] = useState(false)
  const [pass, setPass] = useState(0)

  const run = async () => {
    setRunning(true)
    const total = { due: 0, scanned: 0, notPublished: 0, newAlerts: 0, errors: 0, remaining: 0 }
    try {
      for (let i = 1; i <= MAX_PASSES; i++) {
        setPass(i)
        const result = await runCrossoverScan()
        if (i === 1) total.due = result.due
        total.scanned += result.scanned || 0
        total.notPublished += result.notPublished || 0
        total.newAlerts += result.newAlerts || 0
        total.errors += result.errors?.length || 0
        total.remaining = result.remaining || 0
        const progressed = (result.due || 0) > (result.remaining || 0)
        if (!total.remaining || !progressed) break
      }
      onDone?.({ ok: true, summary: total, message: describeRun(total) })
    } catch (err) {
      const message = err?.response?.status === 409 ? 'A scan is already running - try again in a minute.' : err?.response?.data?.error || err?.message || 'Scan failed'
      onDone?.({ ok: false, message })
    } finally {
      setRunning(false)
      setPass(0)
    }
  }

  return (
    <button
      type="button"
      onClick={run}
      disabled={running}
      title="Scan now instead of waiting for the next automatic run"
      className={`px-md py-sm rounded-lg border border-outline-variant text-sm text-on-surface flex items-center gap-xs disabled:opacity-60 ${className}`}
    >
      {running ? <Spinner /> : <span className="material-symbols-outlined text-[18px]">play_arrow</span>}
      {running ? `Scanning…${pass > 1 ? ` (pass ${pass})` : ''}` : 'Run now'}
    </button>
  )
}
