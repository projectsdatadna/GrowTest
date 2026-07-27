/**
 * Renders whatever the server-side watchlist scheduler (functions/
 * watchlistScheduler.js) has already computed - this tab never triggers a
 * fetch or analysis itself, it only reads the latest watchlistAnalyses doc
 * for the selected symbol+tier and polls on that tier's own cadence.
 *
 * Mirrors Greek Analysis's Current/Previous/Difference 3-column layout,
 * fed from the Watchlist doc's raw snapshots instead of two live auto-refresh
 * runs - see buildSnapshotCardAnalysis in greekAnalysisUtils.js for the
 * adapter between the two shapes.
 */

import { useEffect, useMemo, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { getWatchlistEntries, getLatestWatchlistAnalysis } from '../services/api'
import { setWatchlistEntries, setSelectedSymbol, setSelectedTier, setSelectedPromptType } from '../store/watchlistSlice'
import AnalysisSnapshotCard from './AnalysisSnapshotCard'
import ComparisonPanel from './ComparisonPanel'
import { NarrativeText } from './InstitutionalAnalysisReport'
import NoChangeBanner from './NoChangeBanner'
import MarketPulsePanel from './MarketPulsePanel'
import ProbabilityGauge from './ProbabilityGauge'
import TimelineChart from './TimelineChart'
import OiBuildupPanel from './OiBuildupPanel'
import { computeProbabilityGauge, computeOiChanges, computeGreeksDelta, getMarketSummary, buildSnapshotCardAnalysis } from './greekAnalysisUtils'
import { computeMarketPulse } from './marketPulseEngine'

const TIERS = [
  { key: '5m', label: '5 Minutes', pollMs: 5 * 60 * 1000 },
  { key: '15m', label: '15 Minutes', pollMs: 15 * 60 * 1000 },
  { key: '75m', label: '75 Minutes', pollMs: 75 * 60 * 1000 },
]

const ENTRIES_POLL_MS = 60 * 1000
const LTP_HISTORY_LIMIT = 20

function WatchlistTab() {
  const dispatch = useDispatch()
  const entries = useSelector((state) => state.watchlist.entries)
  const selectedSymbol = useSelector((state) => state.watchlist.selectedSymbol)
  const selectedTier = useSelector((state) => state.watchlist.selectedTier)
  const selectedPromptType = useSelector((state) => state.watchlist.selectedPromptType)

  const [selectedEntryId, setSelectedEntryId] = useState('')
  const [analysis, setAnalysis] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [growwError, setGrowwError] = useState(null)
  const [ltpHistory, setLtpHistory] = useState([])

  useEffect(() => {
    const refresh = () =>
      getWatchlistEntries()
        .then(({ entries: fetched }) => dispatch(setWatchlistEntries(fetched || [])))
        .catch((err) => console.error('Failed to load watchlist entries:', err))
    refresh()
    const id = setInterval(refresh, ENTRIES_POLL_MS)
    return () => clearInterval(id)
  }, [dispatch])

  const symbols = [...new Set(entries.map((e) => e.underlying_symbol))]
  const symbolEntries = entries.filter((e) => e.underlying_symbol === selectedSymbol)

  useEffect(() => {
    if (symbolEntries.length === 0) {
      setSelectedEntryId('')
      return
    }
    if (!symbolEntries.some((e) => e.id === selectedEntryId)) {
      setSelectedEntryId(symbolEntries[0].id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSymbol, entries])

  // Resets the client-accumulated LTP timeline whenever the tracked
  // instrument or tier changes - same "builds up while this view stays open"
  // behavior Greek Analysis's ltpHistory had, just scoped per entry+tier here
  // since a Watchlist entry can be viewed at any of 3 tiers.
  useEffect(() => {
    setLtpHistory([])
  }, [selectedEntryId, selectedTier])

  useEffect(() => {
    if (!selectedEntryId) {
      setAnalysis(null)
      return
    }
    let cancelled = false
    const fetchAnalysis = () => {
      setLoading(true)
      setError('')
      getLatestWatchlistAnalysis(selectedEntryId, selectedTier)
        .then(({ analysis: latest, groww_error }) => {
          if (cancelled) return
          setAnalysis(latest)
          setGrowwError(groww_error || null)

          const ltp = latest?.current_snapshot?.underlying_ltp
          const fetchedAt = latest?.current_snapshot?.fetched_at
          if (ltp != null && fetchedAt) {
            setLtpHistory((prev) => {
              if (prev.length > 0 && prev[prev.length - 1].time === fetchedAt) return prev
              const next = [...prev, { time: fetchedAt, ltp }]
              return next.length > LTP_HISTORY_LIMIT ? next.slice(next.length - LTP_HISTORY_LIMIT) : next
            })
          }
        })
        .catch((err) => {
          if (!cancelled) {
            setError(err.response?.data?.error || err.message || 'Failed to load analysis')
            setGrowwError(null)
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }
    fetchAnalysis()
    const tier = TIERS.find((t) => t.key === selectedTier)
    const id = setInterval(fetchAnalysis, tier.pollMs)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [selectedEntryId, selectedTier])

  const selectedEntry = symbolEntries.find((e) => e.id === selectedEntryId)
  const tierLabel = TIERS.find((t) => t.key === selectedTier)?.label || ''

  const currentAnalysisField = selectedPromptType === 'summarized_recommendations' ? 'summarized_recommendations_analysis' : 'master_prompt_analysis'
  const previousAnalysisField =
    selectedPromptType === 'summarized_recommendations' ? 'previous_summarized_recommendations_analysis' : 'previous_master_prompt_analysis'

  const currentCardData =
    analysis && selectedEntry ? buildSnapshotCardAnalysis(analysis.current_snapshot, selectedEntry, selectedPromptType, analysis[currentAnalysisField]) : null
  const previousCardData =
    analysis && selectedEntry
      ? buildSnapshotCardAnalysis(analysis.previous_snapshot, selectedEntry, selectedPromptType, analysis[previousAnalysisField])
      : null

  const marketSummary = getMarketSummary(currentCardData?.parsed_analysis)
  const probabilityGauge = marketSummary ? computeProbabilityGauge(marketSummary) : null
  const oiChanges = previousCardData && currentCardData ? computeOiChanges(previousCardData, currentCardData) : null
  const greeksDelta = previousCardData && currentCardData ? computeGreeksDelta(previousCardData, currentCardData) : []
  const marketPulse = useMemo(
    () => (currentCardData ? computeMarketPulse(currentCardData, previousCardData) : null),
    [currentCardData, previousCardData]
  )

  // Distinguishes a real, correctly-computed zero (the two snapshots' saved
  // OI/Greeks are genuinely identical) from a broken result, which otherwise
  // render identically as an all-zero/empty set of cards.
  const hasMeaningfulChange =
    !previousCardData || !currentCardData
      ? true
      : greeksDelta.some((g) => g.direction !== 'flat') || (oiChanges?.keyStrikeChanges || []).some((r) => r.oiChange !== 0)

  const insightTrend = currentCardData?.parsed_analysis?.oi_migration?.market_shift || marketSummary?.sentiment
  const insightConfidence = marketSummary?.confidence
  const insightAction =
    marketSummary?.narrative ||
    currentCardData?.parsed_analysis?.strategy_recommendations?.[0]?.strategy ||
    currentCardData?.parsed_analysis?.strategy

  return (
    <div className="flex flex-col gap-lg">
      <section className="flex flex-col gap-xs">
        <h2 className="text-2xl font-bold text-white">Watchlist</h2>
        <p className="text-on-surface-variant text-sm">
          Auto-fetched and analyzed server-side every 5 minutes during market hours (9:15 AM - 3:30 PM IST). Data resets each evening.
        </p>
      </section>

      {symbols.length === 0 ? (
        <div className="glass-panel rounded-xl p-lg text-center text-on-surface-variant text-sm">
          No symbols tracked yet. Add one from the Greek Analysis tab's "Add to Watchlist" button.
        </div>
      ) : (
        <>
          <div className="flex items-center gap-xs border-b border-terminal-border overflow-x-auto">
            {symbols.map((symbol) => (
              <button
                key={symbol}
                type="button"
                onClick={() => dispatch(setSelectedSymbol(symbol))}
                className={`px-lg py-base text-sm font-bold whitespace-nowrap border-b-2 transition-all ${
                  selectedSymbol === symbol
                    ? 'border-primary text-primary'
                    : 'border-transparent text-on-surface-variant hover:text-on-surface'
                }`}
              >
                {symbol}
              </button>
            ))}
          </div>

          {symbolEntries.length > 1 && (
            <div className="flex items-center gap-xs flex-wrap">
              {symbolEntries.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => setSelectedEntryId(entry.id)}
                  className={`px-base py-xs rounded-lg text-xs border transition-all ${
                    selectedEntryId === entry.id
                      ? 'border-primary text-primary bg-primary-container/10'
                      : 'border-terminal-border text-on-surface-variant hover:bg-surface-container-highest'
                  }`}
                >
                  {entry.exchange} · Expiry {entry.expiry_date} · ±{entry.points_range}
                </button>
              ))}
            </div>
          )}

          <div className="flex items-center gap-md flex-wrap">
            <div className="flex items-center gap-xs">
              {TIERS.map((tier) => (
                <button
                  key={tier.key}
                  type="button"
                  onClick={() => dispatch(setSelectedTier(tier.key))}
                  className={`px-md py-sm rounded-lg text-sm transition-all ${
                    selectedTier === tier.key
                      ? 'bg-primary-container text-on-primary-container'
                      : 'border border-terminal-border text-on-surface-variant hover:bg-surface-container-highest'
                  }`}
                >
                  {tier.label}
                </button>
              ))}
            </div>

            <div className="flex flex-col gap-xs">
              <label className="text-[11px] uppercase text-on-surface-variant" htmlFor="wl-prompt_type">
                Prompt Style
              </label>
              <select
                id="wl-prompt_type"
                value={selectedPromptType}
                onChange={(e) => dispatch(setSelectedPromptType(e.target.value))}
                className="bg-surface-container-low border border-terminal-border rounded-lg text-sm px-md py-base min-w-[200px] text-on-surface"
              >
                <option value="master_prompt">Master Prompt</option>
                <option value="summarized_recommendations">Summarized Recommendations</option>
              </select>
            </div>
          </div>

          {selectedEntry && (
            <div className="text-xs text-on-surface-variant">
              {selectedEntry.underlying_symbol} · {selectedEntry.exchange} · Expiry {selectedEntry.expiry_date} · ±{selectedEntry.points_range} pts
              {analysis?.underlying_ltp != null && <> · LTP {analysis.underlying_ltp}</>}
              {analysis?.createdAt && <> · Last analyzed {new Date(analysis.createdAt).toLocaleTimeString()}</>}
            </div>
          )}

          {growwError && (
            <div className="glass-panel rounded-xl p-md border-l-4 border-bearish flex flex-col gap-xs text-sm">
              <div className="text-bearish font-bold uppercase text-xs">Groww API Error</div>
              <div className="text-on-surface">{growwError.message || growwError.error}</div>
              {growwError.groww_error && (
                <pre className="text-[11px] text-on-surface-variant overflow-auto max-h-32 custom-scrollbar">
                  {JSON.stringify(growwError.groww_error, null, 2)}
                </pre>
              )}
              {growwError.occurred_at && (
                <div className="text-[11px] text-on-surface-variant">as of {new Date(growwError.occurred_at).toLocaleTimeString()}</div>
              )}
            </div>
          )}

          {loading && !analysis && <div className="text-on-surface-variant text-sm">Loading...</div>}
          {error && <div className="text-bearish text-sm">{error}</div>}

          {!loading && !error && !analysis && (
            <div className="glass-panel rounded-xl p-lg text-center text-on-surface-variant text-sm">
              No analysis yet for this tier. It appears once the server-side {tierLabel.toLowerCase()} tick has run during market hours.
            </div>
          )}

          {currentCardData && (
            <section className="grid grid-cols-1 md:grid-cols-3 gap-md items-start">
              <AnalysisSnapshotCard
                analysis={currentCardData}
                label={`Current ${tierLabel}`}
                variant="latest"
                timestamp={analysis?.current_snapshot?.fetched_at ? new Date(analysis.current_snapshot.fetched_at) : null}
              />

              {previousCardData ? (
                <AnalysisSnapshotCard
                  analysis={previousCardData}
                  label={`Previous ${tierLabel}`}
                  variant="previous"
                  timestamp={analysis?.previous_snapshot?.fetched_at ? new Date(analysis.previous_snapshot.fetched_at) : null}
                />
              ) : (
                <div className="glass-panel rounded-xl p-md flex items-center justify-center text-on-surface-variant text-sm text-center min-h-[200px]">
                  Waiting for the next auto-refresh cycle to have a prior snapshot to show.
                </div>
              )}

              {/* Every compact/derived card stacked in the 3rd column, filling the
                  height next to the two full institutional reports instead of
                  leaving empty space below a lone Difference panel. */}
              <div className="flex flex-col gap-md">
                {previousCardData && currentCardData && !hasMeaningfulChange && <NoChangeBanner />}

                <ComparisonPanel
                  comparing={false}
                  comparisonError=""
                  promptType={selectedPromptType}
                  oiMigration={currentCardData?.parsed_analysis?.oi_migration}
                  summarizedSections={currentCardData?.parsed_analysis}
                  greeksDelta={greeksDelta}
                />

                <OiBuildupPanel
                  title="Key Strike Changes"
                  rows={oiChanges?.keyStrikeChanges || []}
                  barColorClass="bg-primary"
                  formatLabel={(r) => `${r.strike} ${r.type}`}
                />
                <OiBuildupPanel
                  title="Top OI Buildup Calls"
                  rows={oiChanges?.topCallBuildup || []}
                  barColorClass="bg-bullish"
                  formatLabel={(r) => `${r.strike} CE`}
                />
                <OiBuildupPanel
                  title="Top OI Buildup Puts"
                  rows={oiChanges?.topPutBuildup || []}
                  barColorClass="bg-bearish"
                  formatLabel={(r) => `${r.strike} PE`}
                />

                <MarketPulsePanel
                  parsedAnalysis={marketPulse}
                  meta={marketPulse ? { pcr: marketPulse.pcr, maxPainStrike: marketPulse.maxPainStrike } : null}
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
                      <div className="h-full bg-bullish rounded-full" style={{ width: `${marketSummary?.confidence || 0}%` }} />
                    </div>
                    <div className="text-xs text-on-surface-variant mt-xs">{marketSummary?.confidence ?? 'N/A'}% confidence</div>
                  </div>
                </div>

                <TimelineChart history={ltpHistory.map((point) => ({ ...point, time: new Date(point.time) }))} />

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

                {probabilityGauge && <ProbabilityGauge bullishPct={probabilityGauge.bullishPct} bearishPct={probabilityGauge.bearishPct} />}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}

export default WatchlistTab
