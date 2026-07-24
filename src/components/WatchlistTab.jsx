/**
 * Renders whatever the server-side watchlist scheduler (functions/
 * watchlistScheduler.js) has already computed - this tab never triggers a
 * fetch or analysis itself, it only reads the latest watchlistAnalyses doc
 * for the selected symbol+tier and polls on that tier's own cadence.
 */

import { useEffect, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { getWatchlistEntries, getLatestWatchlistAnalysis } from '../services/api'
import { setWatchlistEntries, setSelectedSymbol, setSelectedTier } from '../store/watchlistSlice'
import InstitutionalAnalysisReport from './InstitutionalAnalysisReport'
import SummarizedRecommendationsReport from './SummarizedRecommendationsReport'

const TIERS = [
  { key: '5m', label: '5 Minutes', pollMs: 5 * 60 * 1000 },
  { key: '15m', label: '15 Minutes', pollMs: 15 * 60 * 1000 },
  { key: '75m', label: '75 Minutes', pollMs: 75 * 60 * 1000 },
]

const ENTRIES_POLL_MS = 60 * 1000

function WatchlistTab() {
  const dispatch = useDispatch()
  const entries = useSelector((state) => state.watchlist.entries)
  const selectedSymbol = useSelector((state) => state.watchlist.selectedSymbol)
  const selectedTier = useSelector((state) => state.watchlist.selectedTier)

  const [selectedEntryId, setSelectedEntryId] = useState('')
  const [analysis, setAnalysis] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

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
        .then(({ analysis: latest }) => {
          if (!cancelled) setAnalysis(latest)
        })
        .catch((err) => {
          if (!cancelled) setError(err.response?.data?.error || err.message || 'Failed to load analysis')
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

          {selectedEntry && (
            <div className="text-xs text-on-surface-variant">
              {selectedEntry.underlying_symbol} · {selectedEntry.exchange} · Expiry {selectedEntry.expiry_date} · ±{selectedEntry.points_range} pts
              {analysis?.underlying_ltp != null && <> · LTP {analysis.underlying_ltp}</>}
              {analysis?.createdAt && <> · Last analyzed {new Date(analysis.createdAt).toLocaleTimeString()}</>}
            </div>
          )}

          {loading && !analysis && <div className="text-on-surface-variant text-sm">Loading...</div>}
          {error && <div className="text-bearish text-sm">{error}</div>}

          {!loading && !error && !analysis && (
            <div className="glass-panel rounded-xl p-lg text-center text-on-surface-variant text-sm">
              No analysis yet for this tier. It appears once the server-side {TIERS.find((t) => t.key === selectedTier)?.label.toLowerCase()} tick
              has run during market hours.
            </div>
          )}

          {analysis && (
            <section className="grid grid-cols-1 lg:grid-cols-2 gap-md items-start">
              <div className="glass-panel rounded-xl p-md flex flex-col gap-md">
                <h3 className="text-sm font-bold text-white uppercase tracking-wider">Master Prompt</h3>
                <InstitutionalAnalysisReport sections={analysis.master_prompt_analysis} />
              </div>
              <div className="glass-panel rounded-xl p-md flex flex-col gap-md">
                <h3 className="text-sm font-bold text-white uppercase tracking-wider">Summarized Recommendations</h3>
                <SummarizedRecommendationsReport sections={analysis.summarized_recommendations_analysis} />
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}

export default WatchlistTab
