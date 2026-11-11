/**
 * The chart shown while hovering a Notifications card: the symbol's candles
 * around the crossover bar (the scanner's own stored candles), a dotted line at
 * the crossover bar, and a checkbox per indicator (RSI, MACD, TSI, Stoch RSI,
 * ADX, DMI, SMA, EMA) that adds/removes its panel or overlay and crossover
 * markers. The indicators that crossed on the card start checked (plus ADX).
 * Loaded lazily (Plotly is heavy) - see NotificationsTab.
 */

import { useEffect, useMemo, useState } from 'react'
import HistoricalCandlestickChart from './HistoricalCandlestickChart'
import { DEFAULT_INDICATOR_CONFIG } from '../store/historicalChartSlice'
import { getCrossoverGroupChart } from '../services/api'
import { formatCrossoverTime, timeframeLabel } from './crossoverFormat'

const cache = new Map() // group id -> chart payload (a crossover bar never changes)
const SMA_COLORS = ['#c1c1ff', '#e0b0ff']
const EMA_COLORS = ['#ffb454', '#ff8a65']

// Checkbox list: `id` is the crossover spec (ADX has no crossover - it is the plain ADX panel).
export const CHART_INDICATORS = [
  { id: 'RSICROSS:14:14', label: 'RSI' },
  { id: 'MACDCROSS:12:26:9', label: 'MACD' },
  { id: 'TSICROSS:25:13:13', label: 'TSI' },
  { id: 'STOCHRSICROSS:14:14:3:3', label: 'Stoch RSI' },
  { id: 'ADX', label: 'ADX' },
  { id: 'DMICROSS:14', label: 'DMI (+DI/-DI)' },
  { id: 'SMACROSS:50:200', label: 'SMA 50/200' },
  { id: 'EMACROSS:12:26', label: 'EMA 12/26' },
]

const nums = (spec) => spec.split(':').slice(1).map(Number)

// The checked indicator ids -> the chart's indicatorConfig (+ extra price lines).
export function cardChartConfig(checked, series = {}) {
  const config = structuredClone(DEFAULT_INDICATOR_CONFIG)
  const overlayLines = []
  config.adx = { enabled: checked.includes('ADX'), period: 14 }
  for (const spec of checked) {
    if (spec === 'ADX') continue
    const [name] = spec.split(':')
    const n = nums(spec)
    if (name === 'MACDCROSS') {
      const p = { fastPeriod: n[0], slowPeriod: n[1], signalPeriod: n[2] }
      config.macd = { enabled: true, ...p }
      config.macdCrossover = { enabled: true, ...p }
    } else if (name === 'TSICROSS') {
      const p = { longPeriod: n[0], shortPeriod: n[1], signalPeriod: n[2] }
      config.tsi = { enabled: true, ...p }
      config.tsiCrossover = { enabled: true, ...p }
    } else if (name === 'STOCHRSICROSS') {
      const p = { rsiPeriod: n[0], stochasticPeriod: n[1], kPeriod: n[2], dPeriod: n[3] }
      config.stochRsi = { enabled: true, ...p }
      config.stochRsiCrossover = { enabled: true, ...p }
    } else if (name === 'DMICROSS') {
      config.adxCrossover = { enabled: true, period: n[0] }
    } else if (name === 'RSICROSS') {
      config.rsi = { enabled: true, period: n[0] }
      config.rsiCrossover = { enabled: true, rsiPeriod: n[0], maPeriod: n[1] }
    } else if (name === 'SMACROSS') {
      config.smaCrossover = { enabled: true, fastPeriod: n[0], slowPeriod: n[1] }
      n.forEach((period, i) => overlayLines.push({ name: `SMA ${period}`, points: series[`SMA:${period}`] || [], color: SMA_COLORS[i] }))
    } else if (name === 'EMACROSS') {
      config.emaCrossover = { enabled: true, fastPeriod: n[0], slowPeriod: n[1] }
      n.forEach((period, i) => overlayLines.push({ name: `EMA ${period}`, points: series[`EMA:${period}`] || [], color: EMA_COLORS[i] }))
    }
  }
  return { config, overlayLines }
}

// Which boxes start checked: the card's crossed indicators, plus ADX.
const initialChecked = (group) => ['ADX', ...group.indicators.map((i) => i.spec).filter((spec) => CHART_INDICATORS.some((c) => c.id === spec))]

export default function CrossoverCardChart({ group }) {
  const [state, setState] = useState(() => (cache.has(group.id) ? { data: cache.get(group.id) } : { loading: true }))
  const [checked, setChecked] = useState(() => initialChecked(group))
  const crossed = useMemo(() => new Set(group.indicators.map((i) => i.spec)), [group])

  useEffect(() => {
    setChecked(initialChecked(group))
  }, [group])

  useEffect(() => {
    if (cache.has(group.id)) {
      setState({ data: cache.get(group.id) })
      return undefined
    }
    let cancelled = false
    setState({ loading: true })
    getCrossoverGroupChart(group.id)
      .then((data) => {
        cache.set(group.id, data)
        if (!cancelled) setState({ data })
      })
      .catch((err) => {
        if (!cancelled) setState({ error: err?.response?.data?.error || err?.message || 'Could not load the chart' })
      })
    return () => {
      cancelled = true
    }
  }, [group.id])

  const view = useMemo(() => (state.data ? cardChartConfig(checked, state.data.series) : null), [state.data, checked])
  const toggle = (id) => setChecked((current) => (current.includes(id) ? current.filter((c) => c !== id) : [...current, id]))

  return (
    <div className="flex flex-col gap-xs">
      <div className="text-xs text-on-surface">
        <span className="font-medium">{group.symbol}</span> · {timeframeLabel(group.interval)} · crossover {formatCrossoverTime(group)}
        <span className="text-on-surface-variant"> · {group.indicators.map((i) => i.label).join(', ')}</span>
      </div>
      <div className="flex flex-wrap gap-x-md gap-y-xs" role="group" aria-label="Indicators">
        {CHART_INDICATORS.map(({ id, label }) => (
          <label key={id} className={`flex items-center gap-xs text-xs cursor-pointer ${crossed.has(id) ? 'text-on-surface font-medium' : 'text-on-surface-variant'}`} title={crossed.has(id) ? 'Crossed on this bar' : undefined}>
            <input type="checkbox" checked={checked.includes(id)} onChange={() => toggle(id)} className="accent-primary" />
            {label}
            {crossed.has(id) && <span aria-hidden="true" className="text-amber-400">●</span>}
          </label>
        ))}
      </div>
      {state.loading && <div className="text-xs text-on-surface-variant py-md">Loading chart…</div>}
      {state.error && <div className="text-xs text-bearish py-md">{state.error}</div>}
      {view && <HistoricalCandlestickChart compact candles={state.data.candles} indicatorSeries={state.data.series} indicatorConfig={view.config} overlayLines={view.overlayLines} highlightTimestamp={state.data.crossoverTimestamp} />}
    </div>
  )
}
