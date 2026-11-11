/**
 * The chart shown while hovering a Notifications card: the symbol's candles
 * around the crossover bar (the scanner's own stored candles), a panel or
 * overlay for each indicator that crossed on the card, the crossover markers,
 * the ADX panel (the card's ADX column) and a dotted line at the crossover bar.
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

const nums = (spec) => spec.split(':').slice(1).map(Number)

// The card's crossover specs -> the chart's indicatorConfig (+ extra price lines).
export function cardChartConfig(specs, series = {}) {
  const config = structuredClone(DEFAULT_INDICATOR_CONFIG)
  const overlayLines = []
  config.adx = { enabled: true, period: 14 }
  for (const spec of specs) {
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

export default function CrossoverCardChart({ group }) {
  const [state, setState] = useState(() => (cache.has(group.id) ? { data: cache.get(group.id) } : { loading: true }))

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

  const view = useMemo(() => (state.data ? cardChartConfig(state.data.specs, state.data.series) : null), [state.data])

  return (
    <div className="flex flex-col gap-xs">
      <div className="text-xs text-on-surface">
        <span className="font-medium">{group.symbol}</span> · {timeframeLabel(group.interval)} · crossover {formatCrossoverTime(group)}
        <span className="text-on-surface-variant"> · {group.indicators.map((i) => i.label).join(', ')}</span>
      </div>
      {state.loading && <div className="text-xs text-on-surface-variant py-md">Loading chart…</div>}
      {state.error && <div className="text-xs text-bearish py-md">{state.error}</div>}
      {view && <HistoricalCandlestickChart compact candles={state.data.candles} indicatorSeries={state.data.series} indicatorConfig={view.config} overlayLines={view.overlayLines} highlightTimestamp={state.data.crossoverTimestamp} />}
    </div>
  )
}
