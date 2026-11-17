/**
 * Option-chain change popover for a Notifications card: for the strikes around
 * the money, the previous value, current value and difference of OI / LTP / IV
 * between this card's bar and one card-interval earlier. Moves of +/-5% or more
 * are highlighted. Plain arithmetic over stored snapshots - no AI.
 */

import { useEffect, useState } from 'react'
import { getCrossoverGroupOptionChain } from '../services/api'
import { CardChartButton, useCardChartHover } from './CardChartHover'

const METRICS = ['OI', 'LTP', 'IV', 'Delta', 'Gamma', 'Theta', 'Vega', 'Rho']
// Greeks near zero (gamma 0, tiny deltas) give huge/undefined %, so the "±5% only" filter skips them.
const GREEK_METRICS = new Set(['Delta', 'Gamma', 'Theta', 'Vega', 'Rho'])
const DECIMALS = { OI: 0, LTP: 2, IV: 4, Delta: 4, Gamma: 4, Theta: 2, Vega: 4, Rho: 4 }
const POPOVER_WIDTH = 720

const REASONS = {
  'no-snapshot': 'No option chain was captured for this bar (only bars after capture started have data, and only optionable symbols).',
  'no-previous': 'No earlier snapshot to compare with yet.',
  'unsupported-interval': 'Option chain change is not available for this timeframe.',
}

const fmt = (value, metric) => {
  if (value == null) return '-'
  const dp = DECIMALS[metric] ?? 2
  return value.toLocaleString('en-IN', { minimumFractionDigits: GREEK_METRICS.has(metric) ? dp : 0, maximumFractionDigits: dp })
}
const signed = (value, metric) => (value == null ? '-' : `${value > 0 ? '+' : ''}${fmt(value, metric)}`)
const tone = (diff) => (diff > 0 ? 'text-bullish' : diff < 0 ? 'text-bearish' : 'text-on-surface-variant')

function SideCells({ cell, metric, threshold }) {
  if (!cell) return <td className="px-xs text-center text-on-surface-variant" colSpan={4}>-</td>
  return (
    <>
      <td className="px-xs text-right font-mono">{fmt(cell.prev, metric)}</td>
      <td className="px-xs text-right font-mono">{fmt(cell.curr, metric)}</td>
      <td className={`px-xs text-right font-mono ${tone(cell.diff)}`}>{signed(cell.diff, metric)}</td>
      <td className={`px-xs text-right font-mono ${tone(cell.diff)} ${cell.flag ? 'font-semibold bg-surface-container-highest rounded' : ''}`} title={cell.flag ? `Moved ${threshold}% or more` : undefined}>
        {cell.pct == null ? '-' : `${cell.pct > 0 ? '+' : ''}${cell.pct}%`}
      </td>
    </>
  )
}

const istTime = (tick) =>
  new Date(tick * 1000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })

export function OptionChainPanel({ group }) {
  const [state, setState] = useState({ loading: true, error: null, data: null })
  const [metric, setMetric] = useState('OI')
  const [flaggedOnly, setFlaggedOnly] = useState(true)

  useEffect(() => {
    let cancelled = false
    getCrossoverGroupOptionChain(group.id)
      .then((data) => !cancelled && setState({ loading: false, error: null, data }))
      .catch((error) => !cancelled && setState({ loading: false, error: error.response?.data?.error || error.message, data: null }))
    return () => {
      cancelled = true
    }
  }, [group.id])

  if (state.loading) return <div className="text-xs text-on-surface-variant py-md">Loading option chain…</div>
  if (state.error) return <div className="text-xs text-bearish py-md">Could not load option chain: {state.error}</div>
  const { data } = state
  if (!data.hasData) return <div className="text-xs text-on-surface-variant py-md">{REASONS[data.reason] || 'No option chain data.'}</div>

  const byStrike = new Map()
  for (const row of data.rows.filter((r) => r.metric === metric)) {
    if (!byStrike.has(row.strike)) byStrike.set(row.strike, {})
    byStrike.get(row.strike)[row.side] = row
  }
  const isGreek = GREEK_METRICS.has(metric)
  const filterActive = flaggedOnly && !isGreek
  const strikes = [...byStrike.entries()].filter(([, sides]) => !filterActive || sides.CE?.flag || sides.PE?.flag)
  const flaggedCount = [...byStrike.values()].reduce((n, s) => n + (s.CE?.flag ? 1 : 0) + (s.PE?.flag ? 1 : 0), 0)

  return (
    <div className="text-xs">
      <div className="flex items-center justify-between gap-sm flex-wrap mb-xs">
        <div className="text-on-surface">
          <span className="font-medium">{group.symbol}</span> option chain · expiry {data.expiry}
          <div className="text-[11px] text-on-surface-variant">
            {istTime(data.prevTick)} → {istTime(data.currTick)} · spot {fmt(data.prevUnderlying, 'LTP')} → {fmt(data.currUnderlying, 'LTP')}
          </div>
        </div>
        <div className="flex items-center gap-sm flex-wrap">
          <div className="flex flex-wrap rounded-lg border border-outline-variant overflow-hidden">
            {METRICS.map((m) => (
              <button key={m} type="button" onClick={() => setMetric(m)} className={`px-sm py-[2px] ${metric === m ? 'bg-primary text-on-primary' : 'text-on-surface-variant'}`}>
                {m}
              </button>
            ))}
          </div>
          <label className={`flex items-center gap-xs text-on-surface-variant ${isGreek ? 'opacity-50' : ''}`} title={isGreek ? 'Filter applies to OI / LTP / IV' : undefined}>
            <input type="checkbox" checked={flaggedOnly} disabled={isGreek} onChange={(e) => setFlaggedOnly(e.target.checked)} />±{data.thresholdPct}% only
          </label>
        </div>
      </div>
      {data.expiryChanged && <div className="text-[11px] text-bearish mb-xs">Expiry rolled over between the two snapshots; compare with care.</div>}
      <div className="text-[11px] text-on-surface-variant mb-xs">
        {flaggedCount} {metric} move(s) of ±{data.thresholdPct}% or more{isGreek ? ' (highlighted; the filter does not apply to Greeks)' : ''}
      </div>
      <table className="w-full border-separate border-spacing-y-[1px]">
        <thead className="text-on-surface-variant sticky top-0 bg-surface-container">
          <tr>
            <th colSpan={4} className="text-center">CALL (CE)</th>
            <th rowSpan={2} className="px-xs">Strike</th>
            <th colSpan={4} className="text-center">PUT (PE)</th>
          </tr>
          <tr>
            {['CE', 'PE'].flatMap((side) => ['Prev', 'Curr', 'Diff', '%'].map((h) => <th key={`${side}${h}`} className="px-xs text-right font-normal">{h}</th>))}
          </tr>
        </thead>
        <tbody>
          {strikes.length === 0 && (
            <tr><td colSpan={9} className="text-center py-sm text-on-surface-variant">{isGreek
                ? `No ${metric} data for these snapshots yet (Greeks are captured from the latest ticks only).`
                : `No ${metric} moves of ±${data.thresholdPct}% or more.`}</td></tr>
          )}
          {strikes.map(([strike, sides]) => (
            <tr key={strike} className="hover:bg-surface-container-highest">
              <SideCells cell={sides.CE} metric={metric} threshold={data.thresholdPct} />
              <td className="px-xs text-center font-mono font-medium text-on-surface">{strike}</td>
              <SideCells cell={sides.PE} metric={metric} threshold={data.thresholdPct} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function useOptionChainHover() {
  return useCardChartHover({ render: (group) => <OptionChainPanel key={group.id} group={group} />, label: 'option chain', width: POPOVER_WIDTH })
}

export function OptionChainButton({ group, hover }) {
  return (
    <CardChartButton
      group={group}
      hover={hover}
      icon="table_chart"
      text="Option chain"
      title="Hover to see option chain changes (previous, current, difference)"
      ariaLabel={`Show option chain changes for ${group.symbol} ${group.interval}`}
    />
  )
}
