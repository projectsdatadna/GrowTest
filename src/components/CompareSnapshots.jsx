import { useEffect, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import Select from 'react-select'
import {
  getUnderlyingSymbols,
  getOptionChainSnapshots,
  getOptionChainSnapshotById,
  compareOptionChainSnapshots,
  regenerateSnapshotAnalysis,
} from '../services/api'
import { setSelectedSymbol, setSnapshotAId, setSnapshotBId, setPromptType, setCompareResult } from '../store/compareSlice'
import AnalysisSnapshotCard from './AnalysisSnapshotCard'
import ComparisonPanel from './ComparisonPanel'
import { NarrativeText } from './InstitutionalAnalysisReport'
import OiBuildupPanel from './OiBuildupPanel'
import NoChangeBanner from './NoChangeBanner'
import MarketPulsePanel from './MarketPulsePanel'
import ProbabilityGauge from './ProbabilityGauge'
import TimelineChart from './TimelineChart'
import { computeOiChanges, computeGreeksDelta, computeProbabilityGauge, getMarketSummary } from './greekAnalysisUtils'
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
  const dispatch = useDispatch()
  const selectedSymbol = useSelector((state) => state.compare.selectedSymbol)
  const snapshotAId = useSelector((state) => state.compare.snapshotAId)
  const snapshotBId = useSelector((state) => state.compare.snapshotBId)
  const promptType = useSelector((state) => state.compare.promptType)
  const result = useSelector((state) => state.compare.result)

  const [underlyingSymbolOptions, setUnderlyingSymbolOptions] = useState([])

  const [snapshots, setSnapshots] = useState([])
  const [loadingSnapshots, setLoadingSnapshots] = useState(false)
  const [snapshotsError, setSnapshotsError] = useState('')

  const [comparing, setComparing] = useState(false)
  const [compareError, setCompareError] = useState('')

  useEffect(() => {
    getUnderlyingSymbols()
      .then(({ symbols }) => setUnderlyingSymbolOptions((symbols || []).map((symbol) => ({ value: symbol, label: symbol }))))
      .catch((err) => console.error('Failed to load underlying symbols:', err))
  }, [])

  // Snapshot selections/result reset atomically in the setSelectedSymbol
  // reducer itself (see compareSlice.js) - this effect only handles
  // (re-)fetching the snapshot list for whichever symbol is now selected,
  // including on mount when a symbol was restored from persisted state.
  useEffect(() => {
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

      // All of these are computed straight from filtered_strikes (raw OI/
      // Greeks), never from parsed_analysis - unaffected by regenerating
      // either snapshot's AI report below.
      const oiChanges = computeOiChanges(previous, latest)
      const greeksDelta = computeGreeksDelta(previous, latest)
      const marketPulse = computeMarketPulse(latest, previous)

      // Distinguishes a real, correctly-computed zero (the two snapshots'
      // saved OI/Greeks are genuinely identical - common for pairs pulled
      // from a stale/quiet stretch of history) from a broken result, which
      // otherwise render identically as an all-zero/empty set of cards.
      const hasMeaningfulChange =
        greeksDelta.some((g) => g.direction !== 'flat') || (oiChanges?.keyStrikeChanges || []).some((r) => r.oiChange !== 0)

      // Full same-instrument history (already fetched for the dropdowns, no
      // extra network call) instead of just the 2 picked points, so this
      // reads like Greek Analysis's own rolling ltpHistory. Keeps `time` as
      // an ISO string (like ltpHistory does) rather than a Date, since Redux
      // state must stay serializable - converted to Date only at render time.
      const priceTimeline = snapshots
        .filter((s) => s.expiry_date === latest.expiry_date && s.exchange === latest.exchange)
        .map((s) => ({ time: s.createdAt, ltp: s.underlying_ltp }))
        .sort((a, b) => new Date(a.time) - new Date(b.time))

      // Snapshot A and B are almost always legacy-schema documents (their
      // stored analysis is the old flat 3-section format), so each gets a
      // fresh institutional report regenerated from its own filtered_strikes
      // and persisted back - permanently upgrading it once viewed. Run
      // alongside the dedicated A-vs-B comparison call (for the compact
      // Difference card) so all three live AI calls happen concurrently
      // instead of tripling the wait. Each has its own try/catch so one
      // failure can't wipe out the others - a failed regeneration just keeps
      // that snapshot's original stored analysis instead of going blank.
      const [previousRegenerated, latestRegenerated, comparisonResult] = await Promise.all([
        regenerateSnapshotAnalysis(previous.id, promptType).catch((err) => {
          console.error('Failed to regenerate previous snapshot analysis:', err)
          return null
        }),
        regenerateSnapshotAnalysis(latest.id, promptType).catch((err) => {
          console.error('Failed to regenerate latest snapshot analysis:', err)
          return null
        }),
        // Same prompt style as the snapshot regenerations above - respects
        // the dropdown so the Difference card can show a diff-aware
        // Summarized Recommendations comparison, not just OI Migration.
        compareOptionChainSnapshots(previous, latest, promptType)
          .then((data) => ({ data }))
          .catch((err) => ({
            error: err.response?.data?.error || err.message || 'Comparison inference failed - other data below is still accurate.',
          })),
      ])

      const finalPrevious = previousRegenerated ? { ...previous, ...previousRegenerated.snapshot } : previous
      const finalLatest = latestRegenerated ? { ...latest, ...latestRegenerated.snapshot } : latest
      const comparison = comparisonResult.data || null
      const comparisonError = comparisonResult.error || ''

      const latestMarketSummary = getMarketSummary(finalLatest.parsed_analysis)
      const probabilityGauge = latestMarketSummary ? computeProbabilityGauge(latestMarketSummary) : null

      dispatch(
        setCompareResult({
          previous: finalPrevious,
          latest: finalLatest,
          comparison,
          comparisonError,
          oiChanges,
          greeksDelta,
          marketPulse,
          probabilityGauge,
          priceTimeline,
          hasMeaningfulChange,
          promptType,
        })
      )
    } catch (err) {
      setCompareError(err.response?.data?.error || err.message || 'Failed to compare snapshots')
    } finally {
      setComparing(false)
    }
  }

  const canAnalyze = snapshotAId && snapshotBId && snapshotAId !== snapshotBId && !comparing

  // Beyond excluding each other's exact pick, also restrict to the same
  // instrument (expiry + exchange) as whatever's already selected on the
  // other side - comparing two different expiries means non-overlapping
  // strikes, which silently empties Key Strike Changes/OI Buildup/Market Pulse.
  const selectedSnapshotA = snapshots.find((s) => s.id === snapshotAId)
  const selectedSnapshotB = snapshots.find((s) => s.id === snapshotBId)

  const snapshotAOptions = snapshots.filter(
    (s) =>
      s.id !== snapshotBId &&
      (!selectedSnapshotB || (s.expiry_date === selectedSnapshotB.expiry_date && s.exchange === selectedSnapshotB.exchange))
  )
  const snapshotBOptions = snapshots.filter(
    (s) =>
      s.id !== snapshotAId &&
      (!selectedSnapshotA || (s.expiry_date === selectedSnapshotA.expiry_date && s.exchange === selectedSnapshotA.exchange))
  )

  // Trend prefers the dedicated A-vs-B comparison (mirrors GreekAnalysis.jsx
  // preferring its own self-consistent oi_migration first). Confidence/Action
  // stay sourced from Snapshot B's own report - same single source as the
  // Overall Bias card, so those two never disagree with each other.
  const marketSummary = getMarketSummary(result?.latest?.parsed_analysis)
  const insightTrend = result?.comparison?.parsed_comparison?.oi_migration?.market_shift || marketSummary?.sentiment
  const insightConfidence = marketSummary?.confidence
  const insightAction =
    marketSummary?.narrative ||
    result?.latest.parsed_analysis?.strategy_recommendations?.[0]?.strategy ||
    result?.latest.parsed_analysis?.strategy

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
            onChange={(selected) => dispatch(setSelectedSymbol(selected?.value || ''))}
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
            onChange={(e) => dispatch(setSnapshotAId(e.target.value))}
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
            onChange={(e) => dispatch(setSnapshotBId(e.target.value))}
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

        <div className="flex flex-col gap-xs">
          <label className="text-[11px] uppercase text-on-surface-variant" htmlFor="cmp-prompt_type">
            Prompt Style
          </label>
          <select
            id="cmp-prompt_type"
            value={promptType}
            onChange={(e) => dispatch(setPromptType(e.target.value))}
            className="bg-surface-container-low border border-terminal-border rounded-lg text-sm px-md py-base min-w-[200px] text-on-surface"
          >
            <option value="master_prompt">Master Prompt</option>
            <option value="summarized_recommendations">Summarized Recommendations</option>
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

            {/* Every compact/derived card stacked in the 3rd column, filling the
                height next to the two full institutional reports instead of
                leaving empty space below a lone Difference panel. */}
            <div className="flex flex-col gap-md">
              {!result.hasMeaningfulChange && <NoChangeBanner />}

              <ComparisonPanel
                comparing={false}
                comparisonError={result.comparisonError || ''}
                promptType={result.promptType}
                oiMigration={result.comparison?.parsed_comparison?.oi_migration}
                summarizedSections={result.comparison?.parsed_comparison}
                greeksDelta={result.greeksDelta}
              />

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

              <MarketPulsePanel
                parsedAnalysis={result.marketPulse}
                meta={result.marketPulse ? { pcr: result.marketPulse.pcr, maxPainStrike: result.marketPulse.maxPainStrike } : null}
              />

              <div className="glass-panel p-md rounded-xl flex flex-col justify-center items-center text-center">
                <h4 className="text-xs uppercase text-on-surface-variant mb-base">Overall Bias</h4>
                <div
                  className={`text-4xl font-bold leading-none mb-base ${
                    marketSummary?.sentiment?.toLowerCase() === 'bullish'
                      ? 'text-bullish'
                      : marketSummary?.sentiment?.toLowerCase() === 'bearish'
                      ? 'text-bearish'
                      : 'text-tertiary'
                  }`}
                >
                  {(marketSummary?.sentiment || 'N/A').toUpperCase()}
                </div>
                <div className="mt-md w-full px-xl">
                  <div className="h-1 w-full bg-surface-container-high rounded-full">
                    <div
                      className="h-full bg-bullish rounded-full"
                      style={{ width: `${marketSummary?.confidence || 0}%` }}
                    />
                  </div>
                  <div className="text-xs text-on-surface-variant mt-xs">
                    {marketSummary?.confidence ?? 'N/A'}% confidence
                  </div>
                </div>
              </div>

              <TimelineChart history={result.priceTimeline.map((point) => ({ ...point, time: new Date(point.time) }))} />

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
                  {marketSummary?.support_level && marketSummary?.resistance_level && (
                    <div className="flex justify-between border-b border-terminal-border/30 pb-xs">
                      <span className="text-on-surface-variant">S/R Zones</span>
                      <span className="text-on-surface font-mono">
                        {marketSummary.support_level} / {marketSummary.resistance_level}
                      </span>
                    </div>
                  )}
                  {insightAction && (
                    <div className="mt-base p-base bg-primary/10 rounded border border-primary/20">
                      <div className="text-[11px] text-primary uppercase mb-xs font-bold">Recommended Action</div>
                      <NarrativeText text={insightAction} className="text-on-surface italic text-sm" />
                    </div>
                  )}
                </div>
              </div>

              {result.probabilityGauge && (
                <ProbabilityGauge bullishPct={result.probabilityGauge.bullishPct} bearishPct={result.probabilityGauge.bearishPct} />
              )}
            </div>
          </section>
        </>
      )}
    </div>
  )
}

export default CompareSnapshots
