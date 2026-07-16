import { useEffect, useState } from 'react'
import Select from 'react-select'
import {
  getUnderlyingSymbols,
  getOptionChainSnapshots,
  getOptionChainSnapshotById,
  compareOptionChainSnapshots,
} from '../services/api'
import AnalysisSnapshotCard from './AnalysisSnapshotCard'
import ComparisonPanel from './ComparisonPanel'
import OiBuildupPanel from './OiBuildupPanel'
import MarketPulsePanel from './MarketPulsePanel'
import ProbabilityGauge from './ProbabilityGauge'
import TimelineChart from './TimelineChart'
import { computeOiChanges, computeGreeksDelta, computeProbabilityGauge } from './greekAnalysisUtils'
import { computeMarketPulse } from './marketPulseEngine'

const underlyingSymbolSelectClassNames = {
  control: () =>
    'bg-surface-container-low border border-terminal-border rounded-lg text-sm px-xs min-w-[180px] text-on-surface',
  placeholder: () => 'text-on-surface-variant',
  input: () => 'text-on-surface',
  singleValue: () => 'text-on-surface',
  menu: () => 'bg-surface-container-low border border-terminal-border rounded-lg mt-xs overflow-hidden z-20',
  menuList: () => 'py-xs',
  option: ({ isFocused, isSelected }) =>
    `px-md py-sm text-sm cursor-pointer ${
      isSelected ? 'bg-primary-container text-on-primary-container' : isFocused ? 'bg-surface-container-highest text-on-surface' : 'text-on-surface'
    }`,
  noOptionsMessage: () => 'text-on-surface-variant text-sm px-md py-sm',
  indicatorSeparator: () => 'bg-terminal-border',
  dropdownIndicator: () => 'text-on-surface-variant',
  clearIndicator: () => 'text-on-surface-variant',
}

function formatSnapshotLabel(snapshot) {
  const when = snapshot.createdAt
    ? new Date(snapshot.createdAt).toLocaleString('en-US', { hour12: false })
    : 'Unknown time'
  return `${when} · Exp ${snapshot.expiry_date} · LTP ₹${snapshot.underlying_ltp}`
}

function CompareSnapshots() {
  const [underlyingSymbolOptions, setUnderlyingSymbolOptions] = useState([])
  const [selectedSymbol, setSelectedSymbol] = useState('')

  const [snapshots, setSnapshots] = useState([])
  const [loadingSnapshots, setLoadingSnapshots] = useState(false)
  const [snapshotsError, setSnapshotsError] = useState('')

  const [snapshotAId, setSnapshotAId] = useState('')
  const [snapshotBId, setSnapshotBId] = useState('')

  const [comparing, setComparing] = useState(false)
  const [compareError, setCompareError] = useState('')
  const [result, setResult] = useState(null)

  useEffect(() => {
    getUnderlyingSymbols()
      .then(({ symbols }) => setUnderlyingSymbolOptions((symbols || []).map((symbol) => ({ value: symbol, label: symbol }))))
      .catch((err) => console.error('Failed to load underlying symbols:', err))
  }, [])

  useEffect(() => {
    setSnapshotAId('')
    setSnapshotBId('')
    setResult(null)
    setCompareError('')

    if (!selectedSymbol) {
      setSnapshots([])
      return
    }

    setLoadingSnapshots(true)
    setSnapshotsError('')
    getOptionChainSnapshots(selectedSymbol)
      .then(({ snapshots: fetchedSnapshots }) => setSnapshots(fetchedSnapshots || []))
      .catch((err) => setSnapshotsError(err.response?.data?.error || err.message || 'Failed to load saved snapshots'))
      .finally(() => setLoadingSnapshots(false))
  }, [selectedSymbol])

  const handleAnalyze = async () => {
    setComparing(true)
    setCompareError('')
    try {
      const [{ snapshot: snapshotA }, { snapshot: snapshotB }] = await Promise.all([
        getOptionChainSnapshotById(snapshotAId),
        getOptionChainSnapshotById(snapshotBId),
      ])

      const [previous, latest] =
        new Date(snapshotA.createdAt) <= new Date(snapshotB.createdAt) ? [snapshotA, snapshotB] : [snapshotB, snapshotA]

      const comparison = await compareOptionChainSnapshots(previous, latest)
      const oiChanges = computeOiChanges(previous, latest)
      const greeksDelta = computeGreeksDelta(previous, latest)
      const marketPulse = computeMarketPulse(latest, previous)
      const probabilityGauge = latest.parsed_analysis ? computeProbabilityGauge(latest.parsed_analysis) : null
      const priceTimeline = [
        { time: new Date(previous.createdAt), ltp: previous.underlying_ltp },
        { time: new Date(latest.createdAt), ltp: latest.underlying_ltp },
      ]

      setResult({ previous, latest, comparison, oiChanges, greeksDelta, marketPulse, probabilityGauge, priceTimeline })
    } catch (err) {
      setCompareError(err.response?.data?.error || err.message || 'Failed to compare snapshots')
    } finally {
      setComparing(false)
    }
  }

  const canAnalyze = snapshotAId && snapshotBId && snapshotAId !== snapshotBId && !comparing

  const snapshotAOptions = snapshots.filter((s) => s.id !== snapshotBId)
  const snapshotBOptions = snapshots.filter((s) => s.id !== snapshotAId)

  const insightTrend = result?.comparison?.parsed_comparison?.trend || result?.latest.parsed_analysis?.sentiment
  const insightConfidence = result?.comparison?.parsed_comparison?.confidence ?? result?.latest.parsed_analysis?.confidence
  const insightAction = result?.comparison?.parsed_comparison?.updated_recommendation || result?.latest.parsed_analysis?.strategy

  return (
    <div className="flex flex-col gap-lg">
      <section className="flex flex-col gap-xs">
        <h2 className="text-2xl font-bold text-white">Compare</h2>
        <p className="text-on-surface-variant text-sm">
          Pick an underlying symbol, choose any two saved analysis runs, and generate an AI trend inference between them.
        </p>
      </section>

      <div className="glass-panel p-md rounded-xl flex items-end gap-lg flex-wrap">
        <div className="flex flex-col gap-xs">
          <label className="text-[11px] uppercase text-on-surface-variant" htmlFor="cmp-underlying_symbol">
            Underlying Symbol
          </label>
          <Select
            inputId="cmp-underlying_symbol"
            unstyled
            isClearable
            options={underlyingSymbolOptions}
            value={selectedSymbol ? { value: selectedSymbol, label: selectedSymbol } : null}
            onChange={(selected) => setSelectedSymbol(selected?.value || '')}
            placeholder="e.g., NIFTY"
            classNames={underlyingSymbolSelectClassNames}
          />
        </div>

        <div className="flex flex-col gap-xs flex-1 min-w-[260px]">
          <label className="text-[11px] uppercase text-on-surface-variant" htmlFor="cmp-snapshot-a">
            Snapshot A
          </label>
          <select
            id="cmp-snapshot-a"
            value={snapshotAId}
            onChange={(e) => setSnapshotAId(e.target.value)}
            disabled={!selectedSymbol || loadingSnapshots}
            className="bg-surface-container-low border border-terminal-border rounded-lg text-sm px-md py-base text-on-surface disabled:opacity-50"
          >
            <option value="">Select a saved run...</option>
            {snapshotAOptions.map((s) => (
              <option key={s.id} value={s.id}>
                {formatSnapshotLabel(s)}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-xs flex-1 min-w-[260px]">
          <label className="text-[11px] uppercase text-on-surface-variant" htmlFor="cmp-snapshot-b">
            Snapshot B
          </label>
          <select
            id="cmp-snapshot-b"
            value={snapshotBId}
            onChange={(e) => setSnapshotBId(e.target.value)}
            disabled={!selectedSymbol || loadingSnapshots}
            className="bg-surface-container-low border border-terminal-border rounded-lg text-sm px-md py-base text-on-surface disabled:opacity-50"
          >
            <option value="">Select a saved run...</option>
            {snapshotBOptions.map((s) => (
              <option key={s.id} value={s.id}>
                {formatSnapshotLabel(s)}
              </option>
            ))}
          </select>
        </div>

        <button
          type="button"
          disabled={!canAnalyze}
          onClick={handleAnalyze}
          className="bg-primary-container text-on-primary-container text-sm px-xl py-lg rounded-lg shadow-lg shadow-primary-container/20 hover:scale-[1.02] active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {comparing ? 'Analyzing...' : 'Analyze'}
        </button>
      </div>

      {selectedSymbol && !loadingSnapshots && snapshots.length === 0 && !snapshotsError && (
        <div className="text-on-surface-variant text-sm px-base">
          No saved runs yet for {selectedSymbol} - run a Greek Analysis for it first.
        </div>
      )}
      {snapshotsError && <div className="text-bearish text-sm px-base">{snapshotsError}</div>}
      {compareError && <div className="text-bearish text-sm px-base">{compareError}</div>}

      {result && (
        <>
          <section className="grid grid-cols-1 md:grid-cols-3 gap-md items-start">
            <AnalysisSnapshotCard
              analysis={result.previous}
              label="Snapshot A (earlier)"
              variant="previous"
              timestamp={result.previous.createdAt ? new Date(result.previous.createdAt) : null}
            />
            <AnalysisSnapshotCard
              analysis={result.latest}
              label="Snapshot B (later)"
              variant="latest"
              timestamp={result.latest.createdAt ? new Date(result.latest.createdAt) : null}
            />
            <ComparisonPanel
              comparing={false}
              comparisonError=""
              comparison={result.comparison}
              greeksDelta={result.greeksDelta}
              title="Trend Inference"
            />
          </section>

          <section className="grid grid-cols-1 md:grid-cols-3 gap-md">
            <OiBuildupPanel
              title="Key Strike Changes"
              rows={result.oiChanges?.keyStrikeChanges || []}
              barColorClass="bg-primary"
              formatLabel={(r) => `${r.strike} ${r.type}`}
            />
            <OiBuildupPanel
              title="Top OI Buildup Calls"
              rows={result.oiChanges?.topCallBuildup || []}
              barColorClass="bg-bullish"
              formatLabel={(r) => `${r.strike} CE`}
            />
            <OiBuildupPanel
              title="Top OI Buildup Puts"
              rows={result.oiChanges?.topPutBuildup || []}
              barColorClass="bg-bearish"
              formatLabel={(r) => `${r.strike} PE`}
            />
          </section>

          <section className="grid grid-cols-1 md:grid-cols-3 gap-md">
            <div className="md:col-span-2">
              <MarketPulsePanel
                parsedAnalysis={result.marketPulse}
                meta={result.marketPulse ? { pcr: result.marketPulse.pcr, maxPainStrike: result.marketPulse.maxPainStrike } : null}
              />
            </div>
            <div className="glass-panel p-md rounded-xl flex flex-col justify-center items-center text-center">
              <h4 className="text-xs uppercase text-on-surface-variant mb-base">Overall Bias</h4>
              <div
                className={`text-4xl font-bold leading-none mb-base ${
                  result.latest.parsed_analysis?.sentiment?.toLowerCase() === 'bullish'
                    ? 'text-bullish'
                    : result.latest.parsed_analysis?.sentiment?.toLowerCase() === 'bearish'
                    ? 'text-bearish'
                    : 'text-tertiary'
                }`}
              >
                {(result.latest.parsed_analysis?.sentiment || 'N/A').toUpperCase()}
              </div>
              <div className="mt-md w-full px-xl">
                <div className="h-1 w-full bg-surface-container-high rounded-full">
                  <div
                    className="h-full bg-bullish rounded-full"
                    style={{ width: `${result.latest.parsed_analysis?.confidence || 0}%` }}
                  />
                </div>
                <div className="text-xs text-on-surface-variant mt-xs">
                  {result.latest.parsed_analysis?.confidence ?? 'N/A'}% confidence
                </div>
              </div>
            </div>
          </section>

          <section className="grid grid-cols-1 md:grid-cols-3 gap-md">
            <TimelineChart history={result.priceTimeline} />

            <div className="glass-panel p-md rounded-xl border-l-4 border-primary">
              <div className="flex items-center gap-base mb-md">
                <span className="material-symbols-outlined text-primary">psychology</span>
                <h4 className="text-xs uppercase text-white">AI Final Insight</h4>
              </div>
              <div className="flex flex-col gap-sm text-sm">
                {insightTrend && (
                  <div className="flex justify-between border-b border-terminal-border/30 pb-xs">
                    <span className="text-on-surface-variant">Trend</span>
                    <span className="font-bold text-on-surface">{insightTrend}</span>
                  </div>
                )}
                {insightConfidence != null && (
                  <div className="flex justify-between border-b border-terminal-border/30 pb-xs">
                    <span className="text-on-surface-variant">Confidence</span>
                    <span className="text-on-surface">{insightConfidence}%</span>
                  </div>
                )}
                {result.latest.parsed_analysis?.support_level && result.latest.parsed_analysis?.resistance_level && (
                  <div className="flex justify-between border-b border-terminal-border/30 pb-xs">
                    <span className="text-on-surface-variant">S/R Zones</span>
                    <span className="text-on-surface font-mono">
                      {result.latest.parsed_analysis.support_level} / {result.latest.parsed_analysis.resistance_level}
                    </span>
                  </div>
                )}
                {insightAction && (
                  <div className="mt-base p-base bg-primary/10 rounded border border-primary/20">
                    <div className="text-[11px] text-primary uppercase mb-xs font-bold">Recommended Action</div>
                    <div className="text-on-surface italic text-sm">{insightAction}</div>
                  </div>
                )}
              </div>
            </div>

            {result.probabilityGauge && (
              <ProbabilityGauge bullishPct={result.probabilityGauge.bullishPct} bearishPct={result.probabilityGauge.bearishPct} />
            )}
          </section>
        </>
      )}
    </div>
  )
}

export default CompareSnapshots
