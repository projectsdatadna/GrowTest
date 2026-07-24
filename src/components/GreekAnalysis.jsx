import { useRef, useState, useEffect } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import Select from 'react-select'
import { analyzeOptionChainRange, getUnderlyingSymbols, addWatchlistEntry, getWatchlistEntries, removeWatchlistEntry } from '../services/api'
import { store } from '../store'
import { setFormData, setGrowToken, applyAnalysisResult, resetAll } from '../store/greekAnalysisSlice'
import { setWatchlistEntries } from '../store/watchlistSlice'
import { exportSnapshotsAsJson } from './greekAnalysisUtils'
import { isSameInstrument } from './marketPulseEngine'

const underlyingSymbolSelectClassNames = {
  control: () =>
    'bg-surface-container-low border border-terminal-border rounded-lg text-sm px-xs min-w-[180px] text-on-surface',
  placeholder: () => 'text-on-surface-variant',
  input: () => 'text-on-surface',
  singleValue: () => 'text-on-surface',
  menu: () => 'bg-surface-container-low border border-terminal-border rounded-lg mt-xs overflow-hidden',
  menuPortal: () => 'z-[9999]',
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

const AUTO_REFRESH_INTERVAL_MS = 5 * 60 * 1000
const AUTO_REFRESH_INTERVAL_MINUTES = AUTO_REFRESH_INTERVAL_MS / 60000

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
  const { exchange, underlying_symbol, expiry_date, points_range, prompt_type } = formData
  return {
    symbol: underlying_symbol,
    underlying_symbol,
    exchange,
    expiry_date,
    points_range: parseFloat(points_range),
    prompt_type,
  }
}

function GreekAnalysis() {
  const dispatch = useDispatch()
  const formData = useSelector((state) => state.greekAnalysis.formData)
  const growToken = useSelector((state) => state.greekAnalysis.growToken)
  const analysis = useSelector((state) => state.greekAnalysis.analysis)
  const previousAnalysis = useSelector((state) => state.greekAnalysis.previousAnalysis)
  const watchlistEntries = useSelector((state) => state.watchlist.entries)

  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [refreshError, setRefreshError] = useState('')

  const [underlyingSymbolOptions, setUnderlyingSymbolOptions] = useState([])

  const [addingToWatchlist, setAddingToWatchlist] = useState(false)
  const [watchlistMessage, setWatchlistMessage] = useState('')

  const intervalRef = useRef(null)
  const paramsRef = useRef(null)

  const refreshWatchlistEntries = () => {
    getWatchlistEntries()
      .then(({ entries }) => dispatch(setWatchlistEntries(entries || [])))
      .catch((err) => console.error('Failed to load watchlist entries:', err))
  }

  useEffect(() => {
    refreshWatchlistEntries()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleAddToWatchlist = async () => {
    setWatchlistMessage('')
    const { exchange, underlying_symbol, expiry_date, points_range } = formData
    if (!exchange || !underlying_symbol || !expiry_date || !points_range) {
      setWatchlistMessage('Fill in Exchange, Underlying Symbol, Points Range and Expiry Date before adding to the watchlist.')
      return
    }
    setAddingToWatchlist(true)
    try {
      await addWatchlistEntry({ underlying_symbol, exchange, expiry_date, points_range: parseFloat(points_range) })
      setWatchlistMessage(`${underlying_symbol} added to the watchlist.`)
      refreshWatchlistEntries()
    } catch (err) {
      setWatchlistMessage(err.response?.data?.error || err.message || 'Failed to add to watchlist')
    } finally {
      setAddingToWatchlist(false)
    }
  }

  const handleRemoveWatchlistEntry = async (id) => {
    try {
      await removeWatchlistEntry(id)
      refreshWatchlistEntries()
    } catch (err) {
      setWatchlistMessage(err.response?.data?.error || err.message || 'Failed to remove watchlist entry')
    }
  }

  useEffect(() => {
    getUnderlyingSymbols()
      .then(({ symbols }) => setUnderlyingSymbolOptions((symbols || []).map((symbol) => ({ value: symbol, label: symbol }))))
      .catch((err) => console.error('Failed to load underlying symbols:', err))
  }, [])

  // Resume the auto-refresh cycle after a remount (tab switch) or a full
  // page reload if we already have a persisted analysis + form params to
  // work from - otherwise the data shown would silently go stale forever.
  // This only reschedules the next tick; it doesn't re-fetch immediately,
  // since the persisted `analysis` is already there to show right away.
  useEffect(() => {
    if (analysis && formData.underlying_symbol && !intervalRef.current) {
      paramsRef.current = buildParams(formData)
      scheduleAutoRefresh()
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
    const { exchange, underlying_symbol, expiry_date, points_range } = formData

    if (!exchange || !underlying_symbol || !expiry_date || points_range === '') {
      setError('All fields are required')
      return false
    }

    const range = parseFloat(points_range)
    if (isNaN(range) || range <= 0) {
      setError('Points range must be a positive number')
      return false
    }

    if (!growToken) {
      setError('Groww access token is required - enter it above to run analysis')
      return false
    }

    return true
  }

  const runAnalysis = async (params, { isAutoRefresh = false } = {}) => {
    if (isAutoRefresh) {
      setRefreshing(true)
      setRefreshError('')
    } else {
      setLoading(true)
      setError('')
    }

    // Guards every path that can (re)send params.expiry_date - initial
    // submit, manual refresh, the auto-refresh timer tick, and the
    // mount-resume effect that continues a persisted session without ever
    // going through form validation again. A persisted expiry_date from an
    // earlier session can silently go stale (this is what caused the
    // deployed site's "No strikes found" 400 - a since-expired weekly
    // contract genuinely has no live strikes to return), so this is checked
    // here rather than only once at submit time.
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    if (params.expiry_date && new Date(params.expiry_date) < today) {
      const message = `Expiry date ${params.expiry_date} has already passed - update it to a current or future expiry before analyzing.`
      if (isAutoRefresh) {
        setRefreshError(message)
        setRefreshing(false)
        if (intervalRef.current) {
          clearInterval(intervalRef.current)
          intervalRef.current = null
        }
      } else {
        setError(message)
        setLoading(false)
      }
      return
    }

    try {
      // Read fresh from the store rather than the growToken selector value,
      // for the same reason priorAnalysis below is read fresh - this runs
      // from a setInterval callback scheduled earlier, whose closure would
      // otherwise send a stale token if the user updates it mid-session.
      const currentGrowToken = store.getState().greekAnalysis.growToken

      // Read the freshest committed state directly from the store rather
      // than a value captured in this closure, which is what makes this
      // safe to call from a setInterval callback that outlives any single
      // render. Only forwarded when it's the same instrument as the new
      // params - the backend independently re-validates this regardless.
      const priorAnalysis = store.getState().greekAnalysis.analysis
      const previous_snapshot =
        priorAnalysis && isSameInstrument(params, priorAnalysis)
          ? {
              underlying_symbol: priorAnalysis.underlying_symbol,
              exchange: priorAnalysis.exchange,
              expiry_date: priorAnalysis.expiry_date,
              underlying_ltp: priorAnalysis.underlying_ltp,
              points_range: priorAnalysis.points_range,
              filtered_strikes: priorAnalysis.filtered_strikes,
            }
          : undefined

      const data = await analyzeOptionChainRange({ ...params, groww_token: currentGrowToken, previous_snapshot })
      const now = new Date().toISOString()

      dispatch(applyAnalysisResult({ data, now }))
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

  // Clears any existing timer and (re)schedules the next auto-refresh tick
  // from now. Shared by the initial submit, the mount-resume effect, and
  // the manual retrigger button, so every path keeps the cadence in sync.
  const scheduleAutoRefresh = () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current)
    }
    intervalRef.current = setInterval(() => {
      if (paramsRef.current) {
        runAnalysis(paramsRef.current, { isAutoRefresh: true })
      }
    }, AUTO_REFRESH_INTERVAL_MS)
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
    scheduleAutoRefresh()
  }

  // Manual "refresh now" - lets you force a new snapshot (and, once a
  // previous one exists, a fresh comparison) without waiting out the full
  // auto-refresh interval, e.g. to compare two points less than
  // AUTO_REFRESH_INTERVAL_MINUTES apart. Reuses the same isAutoRefresh path
  // as the timer tick (previous/current rotation + comparison trigger are
  // identical either way) and resets the cycle to count down from now.
  const handleManualRefresh = async () => {
    if (!paramsRef.current || loading || refreshing) {
      return
    }
    if (!growToken) {
      setRefreshError('Groww access token is required - enter it above to run analysis')
      return
    }
    await runAnalysis(paramsRef.current, { isAutoRefresh: true })
    scheduleAutoRefresh()
  }

  // Wipes the form back to defaults and drops every persisted snapshot -
  // stops the auto-refresh cycle too, since there's nothing left to refresh.
  const handleClear = () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
    paramsRef.current = null
    setError('')
    setRefreshError('')
    dispatch(resetAll())
  }

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
            Auto-refreshing every {AUTO_REFRESH_INTERVAL_MINUTES} minutes
            {refreshing ? ' · refreshing now...' : ''}
          </p>
        </div>
        <div className="flex items-center gap-md">
          <ServerClock />
          <button
            type="button"
            disabled={!analysis || loading || refreshing}
            onClick={handleManualRefresh}
            title={`Force a new snapshot now instead of waiting for the next ${AUTO_REFRESH_INTERVAL_MINUTES}-minute cycle`}
            className="flex items-center gap-sm px-md py-base border border-terminal-border rounded-lg hover:bg-surface-container-highest transition-all text-sm disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <span className="material-symbols-outlined">refresh</span>
            {refreshing ? 'Refreshing...' : 'Refresh Now'}
          </button>
          <button
            type="button"
            disabled={!analysis}
            onClick={() => exportSnapshotsAsJson(analysis, previousAnalysis, null)}
            className="flex items-center gap-sm px-md py-base border border-terminal-border rounded-lg hover:bg-surface-container-highest transition-all text-sm disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <span className="material-symbols-outlined">download</span>
            Export
          </button>
          <button
            type="button"
            disabled={addingToWatchlist || !formData.underlying_symbol || !formData.exchange || !formData.expiry_date || !formData.points_range}
            onClick={handleAddToWatchlist}
            title="Track this symbol on the Watchlist tab - fetched and analyzed automatically every 5 minutes"
            className="flex items-center gap-sm px-md py-base border border-terminal-border rounded-lg hover:bg-surface-container-highest transition-all text-sm disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <span className="material-symbols-outlined">visibility</span>
            {addingToWatchlist ? 'Adding...' : 'Add to Watchlist'}
          </button>
          <button
            type="button"
            disabled={!analysis && !formData.underlying_symbol}
            onClick={handleClear}
            title="Clear the form and every stored analysis snapshot"
            className="flex items-center gap-sm px-md py-base border border-bearish/40 text-bearish rounded-lg hover:bg-bearish/10 transition-all text-sm disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <span className="material-symbols-outlined">delete</span>
            Clear
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
          <Select
            inputId="ga-underlying_symbol"
            unstyled
            isClearable
            options={underlyingSymbolOptions}
            value={formData.underlying_symbol ? { value: formData.underlying_symbol, label: formData.underlying_symbol } : null}
            onChange={(selected) => dispatch(setFormData({ underlying_symbol: selected?.value || '' }))}
            placeholder="e.g., NIFTY"
            classNames={underlyingSymbolSelectClassNames}
            menuPortalTarget={document.body}
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

        <div className="flex flex-col gap-xs">
          <label className="text-[11px] uppercase text-on-surface-variant" htmlFor="ga-prompt_type">
            Prompt Style
          </label>
          <select
            id="ga-prompt_type"
            name="prompt_type"
            value={formData.prompt_type}
            onChange={handleInputChange}
            className="bg-surface-container-low border border-terminal-border rounded-lg text-sm px-md py-base min-w-[200px] text-on-surface"
          >
            <option value="master_prompt">Master Prompt</option>
            <option value="summarized_recommendations">Summarized Recommendations</option>
          </select>
        </div>

        <div className="flex flex-col gap-xs flex-1 min-w-[220px]">
          <label className="text-[11px] uppercase text-on-surface-variant" htmlFor="ga-groww_token">
            Groww Access Token
          </label>
          <input
            id="ga-groww_token"
            type="password"
            value={growToken}
            onChange={(e) => dispatch(setGrowToken(e.target.value))}
            placeholder="Paste your Groww access token"
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
      {watchlistMessage && <div className="text-sm px-base text-on-surface-variant">{watchlistMessage}</div>}

      <section className="glass-panel p-md rounded-xl flex flex-col gap-sm">
        <h3 className="text-sm font-bold text-white uppercase tracking-wider">Watchlist</h3>
        {watchlistEntries.length === 0 ? (
          <p className="text-on-surface-variant text-sm">
            No symbols tracked yet. Fill in the form above and click "Add to Watchlist" to auto-analyze it every 5 minutes on the Watchlist tab.
          </p>
        ) : (
          <ul className="flex flex-col gap-xs">
            {watchlistEntries.map((entry) => (
              <li
                key={entry.id}
                className="flex items-center justify-between gap-md px-base py-sm bg-surface-container-low border border-terminal-border rounded-lg text-sm"
              >
                <span className="text-on-surface">
                  {entry.underlying_symbol} · {entry.exchange} · Expiry {entry.expiry_date} · ±{entry.points_range} pts
                </span>
                <button
                  type="button"
                  onClick={() => handleRemoveWatchlistEntry(entry.id)}
                  className="flex items-center gap-xs px-sm py-1 border border-bearish/40 text-bearish rounded hover:bg-bearish/10 transition-all text-xs"
                >
                  <span className="material-symbols-outlined text-sm">delete</span>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

export default GreekAnalysis
