import { useRef, useState, useEffect } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { analyzeOptionChainRange, compareOptionChainSnapshots } from '../services/api'
import { store } from '../store'
import { setFormData, applyAnalysisResult, setComparison } from '../store/greekAnalysisSlice'
import AnalysisSnapshotCard from './AnalysisSnapshotCard'
import MarketPulsePanel from './MarketPulsePanel'
import ProbabilityGauge from './ProbabilityGauge'
import TimelineChart from './TimelineChart'
import OiBuildupPanel from './OiBuildupPanel'
import { computeProbabilityGauge, computeOiChanges, computeGreeksDelta, exportSnapshotsAsJson } from './greekAnalysisUtils'

const AUTO_REFRESH_INTERVAL_MS = 15 * 60 * 1000

function ServerClock() {
  const [now, setNow] = useState(new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])
  return (
    <div className="text-right">
      <p className="text-[10px] uppercase text-on-surface-variant">Server Time</p>
      <p className="text-on-surface font-mono">{now.toLocaleTimeString('en-US', { hour12: false })}</p>
    </div>
  )
}

function buildParams(formData) {
  const { exchange, underlying_symbol, trading_symbol, expiry_date, points_range } = formData
  return {
    symbol: underlying_symbol,
    underlying_symbol,
    trading_symbol,
    exchange,
    expiry_date,
    points_range: parseFloat(points_range),
  }
}

function GreekAnalysis() {
  const dispatch = useDispatch()
  const formData = useSelector((state) => state.greekAnalysis.formData)
  const analysis = useSelector((state) => state.greekAnalysis.analysis)
  const lastUpdated = useSelector((state) => state.greekAnalysis.lastUpdated)
  const previousAnalysis = useSelector((state) => state.greekAnalysis.previousAnalysis)
  const previousUpdated = useSelector((state) => state.greekAnalysis.previousUpdated)
  const comparison = useSelector((state) => state.greekAnalysis.comparison)
  const ltpHistory = useSelector((state) => state.greekAnalysis.ltpHistory)

  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [refreshError, setRefreshError] = useState('')

  const [comparing, setComparing] = useState(false)
  const [comparisonError, setComparisonError] = useState('')

  const intervalRef = useRef(null)
  const paramsRef = useRef(null)

  // Resume the auto-refresh cycle after a remount (tab switch) or a full
  // page reload if we already have a persisted analysis + form params to
  // work from - otherwise the data shown would silently go stale forever.
  // This only reschedules the next tick; it doesn't re-fetch immediately,
  // since the persisted `analysis` is already there to show right away.
  useEffect(() => {
    if (analysis && formData.underlying_symbol && !intervalRef.current) {
      paramsRef.current = buildParams(formData)
      intervalRef.current = setInterval(() => {
        if (paramsRef.current) {
          runAnalysis(paramsRef.current, { isAutoRefresh: true })
        }
      }, AUTO_REFRESH_INTERVAL_MS)
    }
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleInputChange = (e) => {
    const { name, value } = e.target
    dispatch(setFormData({ [name]: value }))
  }

  const validateForm = () => {
    const { exchange, underlying_symbol, trading_symbol, expiry_date, points_range } = formData

    if (!exchange || !underlying_symbol || !trading_symbol || !expiry_date || points_range === '') {
      setError('All fields are required')
      return false
    }

    const range = parseFloat(points_range)
    if (isNaN(range) || range <= 0) {
      setError('Points range must be a positive number')
      return false
    }

    return true
  }

  const runComparison = async (previous, latest) => {
    setComparing(true)
    setComparisonError('')
    try {
      const result = await compareOptionChainSnapshots(previous, latest)
      dispatch(setComparison(result))
    } catch (err) {
      setComparisonError(err.response?.data?.error || err.message || 'Failed to generate comparison')
    } finally {
      setComparing(false)
    }
  }

  const runAnalysis = async (params, { isAutoRefresh = false } = {}) => {
    if (isAutoRefresh) {
      setRefreshing(true)
      setRefreshError('')
    } else {
      setLoading(true)
      setError('')
    }

    try {
      const data = await analyzeOptionChainRange(params)
      const now = new Date().toISOString()

      // Read the freshest committed state directly from the store rather
      // than a value captured in this closure, which is what makes this
      // safe to call from a setInterval callback that outlives any single
      // render.
      const priorAnalysis = store.getState().greekAnalysis.analysis

      dispatch(applyAnalysisResult({ data, now }))

      if (priorAnalysis) {
        runComparison(priorAnalysis, data)
      }
    } catch (err) {
      const message = err.response?.data?.error || err.message || 'An error occurred during analysis'
      if (isAutoRefresh) {
        setRefreshError(`Auto-refresh failed: ${message}. Retrying next cycle.`)
      } else {
        setError(message)
      }
    } finally {
      if (isAutoRefresh) {
        setRefreshing(false)
      } else {
        setLoading(false)
      }
    }
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')

    if (!validateForm()) {
      return
    }

    const params = buildParams(formData)
    paramsRef.current = params

    await runAnalysis(params)

    if (intervalRef.current) {
      clearInterval(intervalRef.current)
    }
    intervalRef.current = setInterval(() => {
      if (paramsRef.current) {
        runAnalysis(paramsRef.current, { isAutoRefresh: true })
      }
    }, AUTO_REFRESH_INTERVAL_MS)
  }

  const probabilityGauge = analysis?.parsed_analysis ? computeProbabilityGauge(analysis.parsed_analysis) : null
  const oiChanges = previousAnalysis && analysis ? computeOiChanges(previousAnalysis, analysis) : null
  const greeksDelta = previousAnalysis && analysis ? computeGreeksDelta(previousAnalysis, analysis) : []

  const insightTrend = comparison?.parsed_comparison?.trend || analysis?.parsed_analysis?.sentiment
  const insightConfidence = comparison?.parsed_comparison?.confidence ?? analysis?.parsed_analysis?.confidence
  const insightAction = comparison?.parsed_comparison?.updated_recommendation || analysis?.parsed_analysis?.strategy

  return (
    <div className="flex flex-col gap-lg">
      <section className="flex justify-between items-end flex-wrap gap-md">
        <div className="flex flex-col gap-xs">
          <div className="flex items-center gap-md">
            <h2 className="text-2xl font-bold text-white">Greek Analysis</h2>
            {analysis && (
              <span className="flex items-center gap-xs px-base py-0.5 bg-bullish/10 text-bullish text-[11px] font-bold rounded uppercase tracking-wider">
                <span className="w-2 h-2 bg-bullish rounded-full pulse-live" />
                LIVE
              </span>
            )}
          </div>
          <p className="text-on-surface-variant text-sm">
            Auto-refreshing every 15 minutes
            {refreshing ? ' · refreshing now...' : ''}
          </p>
        </div>
        <div className="flex items-center gap-md">
          <ServerClock />
          <button
            type="button"
            disabled={!analysis}
            onClick={() => exportSnapshotsAsJson(analysis, previousAnalysis, comparison)}
            className="flex items-center gap-sm px-md py-base border border-terminal-border rounded-lg hover:bg-surface-container-highest transition-all text-sm disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <span className="material-symbols-outlined">download</span>
            Export
          </button>
        </div>
      </section>

      <form
        onSubmit={handleSubmit}
        className="glass-panel p-md rounded-xl flex items-end gap-lg flex-wrap"
      >
        <div className="flex flex-col gap-xs">
          <label className="text-[11px] uppercase text-on-surface-variant" htmlFor="ga-exchange">
            Exchange
          </label>
          <select
            id="ga-exchange"
            name="exchange"
            value={formData.exchange}
            onChange={handleInputChange}
            className="bg-surface-container-low border border-terminal-border rounded-lg text-sm px-md py-base min-w-[120px] text-on-surface"
          >
            <option value="NSE">NSE</option>
            <option value="BSE">BSE</option>
          </select>
        </div>

        <div className="flex flex-col gap-xs">
          <label className="text-[11px] uppercase text-on-surface-variant" htmlFor="ga-underlying_symbol">
            Underlying Symbol
          </label>
          <input
            id="ga-underlying_symbol"
            type="text"
            name="underlying_symbol"
            value={formData.underlying_symbol}
            onChange={handleInputChange}
            placeholder="e.g., NIFTY"
            className="bg-surface-container-low border border-terminal-border rounded-lg text-sm px-md py-base min-w-[140px] text-on-surface"
          />
        </div>

        <div className="flex flex-col gap-xs">
          <label className="text-[11px] uppercase text-on-surface-variant" htmlFor="ga-trading_symbol">
            Trading Symbol
          </label>
          <input
            id="ga-trading_symbol"
            type="text"
            name="trading_symbol"
            value={formData.trading_symbol}
            onChange={handleInputChange}
            placeholder="e.g., NIFTY24JUL25000CE"
            className="bg-surface-container-low border border-terminal-border rounded-lg text-sm px-md py-base min-w-[180px] text-on-surface"
          />
        </div>

        <div className="flex flex-col gap-xs flex-1 min-w-[160px]">
          <label className="text-[11px] uppercase text-on-surface-variant flex justify-between" htmlFor="ga-points_range">
            Points Range (+/-) <span>{formData.points_range}</span>
          </label>
          <input
            id="ga-points_range"
            type="number"
            name="points_range"
            value={formData.points_range}
            onChange={handleInputChange}
            placeholder="e.g., 500"
            step="50"
            min="50"
            className="bg-surface-container-low border border-terminal-border rounded-lg text-sm px-md py-base text-on-surface"
          />
        </div>

        <div className="flex flex-col gap-xs">
          <label className="text-[11px] uppercase text-on-surface-variant" htmlFor="ga-expiry_date">
            Expiry Date
          </label>
          <input
            id="ga-expiry_date"
            type="date"
            name="expiry_date"
            value={formData.expiry_date}
            onChange={handleInputChange}
            className="bg-surface-container-low border border-terminal-border rounded-lg text-sm px-md py-base text-on-surface"
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          className="bg-primary-container text-on-primary-container text-sm px-xl py-lg rounded-lg shadow-lg shadow-primary-container/20 hover:scale-[1.02] active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? 'Analyzing...' : 'Start Greek Analysis'}
        </button>
      </form>

      {error && <div className="text-bearish text-sm px-base">{error}</div>}
      {refreshError && <div className="text-tertiary text-sm px-base">{refreshError}</div>}

      {analysis && (
        <>
          <section className="grid grid-cols-1 md:grid-cols-3 gap-md items-start">
            <AnalysisSnapshotCard
              analysis={analysis}
              label="Current 15 Minutes"
              variant="latest"
              timestamp={lastUpdated ? new Date(lastUpdated) : null}
            />

            {previousAnalysis ? (
              <AnalysisSnapshotCard
                analysis={previousAnalysis}
                label="Previous 15 Minutes"
                variant="previous"
                timestamp={previousUpdated ? new Date(previousUpdated) : null}
              />
            ) : (
              <div className="glass-panel rounded-xl p-md flex items-center justify-center text-on-surface-variant text-sm text-center min-h-[200px]">
                Waiting for the next auto-refresh cycle to have a prior snapshot to show.
              </div>
            )}

            <div className="glass-panel rounded-xl overflow-hidden">
              <div className="p-md border-b border-terminal-border bg-white/5">
                <h3 className="text-base font-bold text-white">Difference</h3>
              </div>
              <div className="p-md flex flex-col gap-md">
                {!previousAnalysis ? (
                  <div className="text-on-surface-variant text-sm text-center py-lg">
                    Comparison appears once there are two snapshots to compare.
                  </div>
                ) : comparing ? (
                  <div className="text-on-surface-variant text-sm text-center py-lg">Generating comparison inference...</div>
                ) : comparisonError ? (
                  <div className="text-bearish text-sm">{comparisonError}</div>
                ) : (
                  <>
                    {comparison?.parsed_comparison && (
                      <div className="flex flex-col gap-base text-sm">
                        <div className="flex justify-between border-b border-terminal-border/30 pb-xs">
                          <span className="text-on-surface-variant">Trend</span>
                          <span
                            className={`font-bold ${
                              comparison.parsed_comparison.trend?.toLowerCase().includes('strength')
                                ? 'text-bullish'
                                : comparison.parsed_comparison.trend?.toLowerCase().includes('revers') ||
                                  comparison.parsed_comparison.trend?.toLowerCase().includes('weak')
                                ? 'text-bearish'
                                : 'text-tertiary'
                            }`}
                          >
                            {comparison.parsed_comparison.trend}
                          </span>
                        </div>
                        {comparison.parsed_comparison.confidence && (
                          <div className="flex justify-between border-b border-terminal-border/30 pb-xs">
                            <span className="text-on-surface-variant">Confidence</span>
                            <span className="text-on-surface">{comparison.parsed_comparison.confidence}%</span>
                          </div>
                        )}
                        {comparison.parsed_comparison.ltp_change_summary && (
                          <p className="text-on-surface-variant">{comparison.parsed_comparison.ltp_change_summary}</p>
                        )}
                      </div>
                    )}

                    {greeksDelta.length > 0 && (
                      <table className="w-full text-xs mt-base">
                        <thead>
                          <tr className="text-on-surface-variant text-left border-b border-terminal-border">
                            <th className="pb-sm font-medium">Change (avg)</th>
                            <th className="pb-sm font-medium text-right">Reason</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-terminal-border/50">
                          {greeksDelta.map((g) => (
                            <tr key={g.key}>
                              <td className="py-sm">
                                <div className="flex items-center gap-base">
                                  <span
                                    className={`material-symbols-outlined text-base ${
                                      g.avgChange >= 0 ? 'text-bullish' : 'text-bearish'
                                    }`}
                                  >
                                    {g.avgChange >= 0 ? 'trending_up' : 'trending_down'}
                                  </span>
                                  <div>
                                    <div className={`font-mono ${g.avgChange >= 0 ? 'text-bullish' : 'text-bearish'}`}>
                                      {g.avgChange >= 0 ? '+' : ''}
                                      {g.avgChange.toFixed(4)}
                                    </div>
                                    <div className="text-[10px] opacity-60">{g.label}</div>
                                  </div>
                                </div>
                              </td>
                              <td className="py-sm text-right text-on-surface-variant">{g.reason}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </>
                )}
              </div>
            </div>
          </section>

          <section className="grid grid-cols-1 md:grid-cols-3 gap-md">
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
          </section>

          <section className="grid grid-cols-1 md:grid-cols-3 gap-md">
            <div className="md:col-span-2">
              <MarketPulsePanel parsedAnalysis={analysis.parsed_analysis} />
            </div>
            <div className="glass-panel p-md rounded-xl flex flex-col justify-center items-center text-center">
              <h4 className="text-xs uppercase text-on-surface-variant mb-base">Overall Bias</h4>
              <div
                className={`text-4xl font-bold leading-none mb-base ${
                  analysis.parsed_analysis?.sentiment?.toLowerCase() === 'bullish'
                    ? 'text-bullish'
                    : analysis.parsed_analysis?.sentiment?.toLowerCase() === 'bearish'
                    ? 'text-bearish'
                    : 'text-tertiary'
                }`}
              >
                {(analysis.parsed_analysis?.sentiment || 'N/A').toUpperCase()}
              </div>
              <div className="mt-md w-full px-xl">
                <div className="h-1 w-full bg-surface-container-high rounded-full">
                  <div
                    className="h-full bg-bullish rounded-full"
                    style={{ width: `${analysis.parsed_analysis?.confidence || 0}%` }}
                  />
                </div>
                <div className="text-xs text-on-surface-variant mt-xs">{analysis.parsed_analysis?.confidence ?? 'N/A'}% confidence</div>
              </div>
            </div>
          </section>

          <section className="grid grid-cols-1 md:grid-cols-3 gap-md">
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
                {analysis.parsed_analysis?.support_level && analysis.parsed_analysis?.resistance_level && (
                  <div className="flex justify-between border-b border-terminal-border/30 pb-xs">
                    <span className="text-on-surface-variant">S/R Zones</span>
                    <span className="text-on-surface font-mono">
                      {analysis.parsed_analysis.support_level} / {analysis.parsed_analysis.resistance_level}
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

            {probabilityGauge && <ProbabilityGauge bullishPct={probabilityGauge.bullishPct} bearishPct={probabilityGauge.bearishPct} />}
          </section>
        </>
      )}
    </div>
  )
}

export default GreekAnalysis
