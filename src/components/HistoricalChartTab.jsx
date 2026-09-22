/**
 * Historical Chart tab - lets the user search any NSE/BSE cash-equity
 * instrument by symbol OR company name (see functions/instrumentMasterSync.js)
 * plus exchange/interval, fetches OHLC candles (stored server-side in
 * Firestore, fetched from Groww only for what's missing/stale - see
 * functions/growwHistoricalData.js), then optionally computes+stores and
 * renders technical indicators alongside the price chart. Also offers an
 * on-demand AI insight over whatever's currently loaded, and lets the
 * current symbol/exchange/interval be added to the Historical Watchlist for
 * automated background refresh (functions/historicalWatchlistScheduler.js).
 *
 * Mounted twice (App.jsx's 'chart' and 'chart2' tabs) with different
 * `instanceKey` props so each copy keeps fully independent state - see
 * CHART_INSTANCES below and src/store/historicalChartSlice.js's factory.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import AsyncSelect from 'react-select/async'
import {
  getHistoricalCandles,
  getIndicatorSeries,
  getHistoricalAiInsight,
  searchInstruments,
  addHistoricalWatchlistEntry,
  getHistoricalWatchlistEntries,
  removeHistoricalWatchlistEntry,
} from '../services/api'
import { historicalChartPrimarySlice, historicalChartSecondarySlice } from '../store/index'
import { setHistoricalWatchlistEntries } from '../store/historicalWatchlistSlice'
import HistoricalCandlestickChart from './HistoricalCandlestickChart'
import Spinner from './Spinner'

const CHART_INSTANCES = {
  primary: { stateKey: 'historicalChartPrimary', actions: historicalChartPrimarySlice.actions },
  secondary: { stateKey: 'historicalChartSecondary', actions: historicalChartSecondarySlice.actions },
}

const underlyingSymbolSelectClassNames = {
  control: () =>
    'bg-surface-container-low border border-terminal-border rounded-lg text-sm px-xs min-w-[220px] text-on-surface',
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
  loadingMessage: () => 'text-on-surface-variant text-sm px-md py-sm',
  indicatorSeparator: () => 'bg-terminal-border',
  dropdownIndicator: () => 'text-on-surface-variant',
  clearIndicator: () => 'text-on-surface-variant',
}

// Every value here is confirmed against a live Groww call and matches
// functions/growwHistoricalData.js's SUPPORTED_INTERVALS exactly - don't add
// more without verifying candle_interval acceptance live first (Groww's
// accepted set is a specific enum: e.g. '60minute' is rejected, the hour
// interval is '1hour').
const INTERVAL_OPTIONS = [
  { value: '1minute', label: '1 Minute' },
  { value: '2minute', label: '2 Minute' },
  { value: '3minute', label: '3 Minute' },
  { value: '5minute', label: '5 Minute' },
  { value: '10minute', label: '10 Minute' },
  { value: '15minute', label: '15 Minute' },
  { value: '30minute', label: '30 Minute' },
  { value: '1hour', label: '1 Hour' },
  { value: '4hour', label: '4 Hour' },
  { value: '1day', label: '1 Day' },
  { value: '1week', label: '1 Week' },
  { value: '1month', label: '1 Month' },
]

// A reasonable default window per interval, shown until the user picks
// their own Start/End - wide enough to be useful, comfortably inside that
// interval's own MAX_SPAN_DAYS cap (functions/growwHistoricalData.js)
// without necessarily maxing it out.
const DEFAULT_LOOKBACK_DAYS = {
  '1minute': 2,
  '2minute': 2,
  '3minute': 2,
  '5minute': 5,
  '10minute': 7,
  '15minute': 7,
  '30minute': 14,
  '1hour': 30,
  '4hour': 60,
  '1day': 180,
  '1week': 365 * 2,
  '1month': 365 * 3,
}

// Formats a JS Date as a datetime-local input value ('YYYY-MM-DDTHH:mm') in
// IST, regardless of the browser's own timezone - this app's dates are
// always IST wall-clock (matching Groww's own start_time/end_time contract),
// same technique as the backend's formatGrowwDateTime.
function formatIstForInput(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date)
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]))
  return `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}`
}

function computeDefaultRange(interval) {
  const now = new Date()
  const lookbackDays = DEFAULT_LOOKBACK_DAYS[interval] ?? 30
  const start = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000)
  return { startTime: formatIstForInput(start), endTime: formatIstForInput(now) }
}

const INDICATOR_ROWS = [
  { key: 'sma', label: 'SMA', fields: [{ name: 'period', label: 'Period' }] },
  { key: 'ema', label: 'EMA', fields: [{ name: 'period', label: 'Period' }] },
  { key: 'bollingerBands', label: 'Bollinger Bands', fields: [{ name: 'period', label: 'Period' }, { name: 'stdDev', label: 'Std Dev' }] },
  { key: 'rsi', label: 'RSI', fields: [{ name: 'period', label: 'Period' }] },
  { key: 'macd', label: 'MACD', fields: [{ name: 'fastPeriod', label: 'Fast' }, { name: 'slowPeriod', label: 'Slow' }, { name: 'signalPeriod', label: 'Signal' }] },
  { key: 'supportResistance', label: 'Support/Resistance', fields: [{ name: 'lookback', label: 'Lookback' }] },
  { key: 'tsi', label: 'TSI', fields: [{ name: 'longPeriod', label: 'Long' }, { name: 'shortPeriod', label: 'Short' }, { name: 'signalPeriod', label: 'Signal' }] },
  {
    key: 'stochRsi',
    label: 'Stoch RSI',
    fields: [
      { name: 'rsiPeriod', label: 'RSI' },
      { name: 'stochasticPeriod', label: 'Stoch' },
      { name: 'kPeriod', label: 'K' },
      { name: 'dPeriod', label: 'D' },
    ],
  },
  { key: 'adx', label: 'ADX', fields: [{ name: 'period', label: 'Period' }] },
]

function buildIndicatorSpecs(indicatorConfig) {
  const specs = []
  if (indicatorConfig.sma.enabled) specs.push(`SMA:${indicatorConfig.sma.period}`)
  if (indicatorConfig.ema.enabled) specs.push(`EMA:${indicatorConfig.ema.period}`)
  if (indicatorConfig.bollingerBands.enabled) specs.push(`BB:${indicatorConfig.bollingerBands.period}:${indicatorConfig.bollingerBands.stdDev}`)
  if (indicatorConfig.rsi.enabled) specs.push(`RSI:${indicatorConfig.rsi.period}`)
  if (indicatorConfig.macd.enabled) specs.push(`MACD:${indicatorConfig.macd.fastPeriod}:${indicatorConfig.macd.slowPeriod}:${indicatorConfig.macd.signalPeriod}`)
  if (indicatorConfig.supportResistance.enabled) specs.push(`SR:${indicatorConfig.supportResistance.lookback}`)
  if (indicatorConfig.tsi.enabled) specs.push(`TSI:${indicatorConfig.tsi.longPeriod}:${indicatorConfig.tsi.shortPeriod}:${indicatorConfig.tsi.signalPeriod}`)
  if (indicatorConfig.stochRsi.enabled) {
    const { rsiPeriod, stochasticPeriod, kPeriod, dPeriod } = indicatorConfig.stochRsi
    specs.push(`STOCHRSI:${rsiPeriod}:${stochasticPeriod}:${kPeriod}:${dPeriod}`)
  }
  if (indicatorConfig.adx.enabled) specs.push(`ADX:${indicatorConfig.adx.period}`)
  return specs
}

function IndicatorControlRow({ row, config, onChange }) {
  return (
    <div className="flex items-center gap-sm flex-wrap">
      <label className="flex items-center gap-xs text-sm text-on-surface min-w-[160px]">
        <input type="checkbox" checked={config.enabled} onChange={(e) => onChange({ enabled: e.target.checked })} />
        {row.label}
      </label>
      {row.fields.map((field) => (
        <IndicatorNumberInput key={field.name} label={field.label} value={config[field.name]} onCommit={(value) => onChange({ [field.name]: value })} />
      ))}
    </div>
  )
}

// Local draft state + commit-on-blur, so typing a new period doesn't
// dispatch (and re-fetch indicators) on every keystroke.
function IndicatorNumberInput({ label, value, onCommit }) {
  const [draft, setDraft] = useState(String(value))

  useEffect(() => {
    setDraft(String(value))
  }, [value])

  const commit = () => {
    const parsed = Number(draft)
    if (Number.isFinite(parsed) && parsed > 0) {
      onCommit(parsed)
    } else {
      setDraft(String(value))
    }
  }

  return (
    <label className="flex items-center gap-xs text-xs text-on-surface-variant">
      {label}
      <input
        type="number"
        className="bg-surface-container-low border border-terminal-border rounded-lg text-sm px-sm py-[2px] w-16 text-on-surface"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
    </label>
  )
}

const OUTLOOK_STYLES = {
  bullish: 'bg-bullish/15 text-bullish',
  bearish: 'bg-bearish/15 text-bearish',
  neutral: 'bg-surface-container-highest text-on-surface-variant',
}

function AiInsightCard({ insight }) {
  const analysis = insight.parsed_analysis
  if (!analysis) {
    return (
      <div className="glass-panel p-md rounded-xl text-sm text-on-surface-variant">
        AI response could not be parsed as structured data{insight.raw_text ? ':' : '.'}
        {insight.raw_text && <p className="mt-xs whitespace-pre-wrap text-xs">{insight.raw_text}</p>}
      </div>
    )
  }
  return (
    <div className="glass-panel p-md rounded-xl flex flex-col gap-sm">
      <div className="flex items-center justify-between flex-wrap gap-sm">
        <h4 className="text-xs font-medium text-on-surface-variant uppercase">AI Insight</h4>
        <div className="flex items-center gap-xs">
          <span className={`px-sm py-[2px] rounded-full text-xs font-medium capitalize ${OUTLOOK_STYLES[analysis.outlook] || OUTLOOK_STYLES.neutral}`}>
            {analysis.outlook || 'neutral'}
          </span>
          <span className="px-sm py-[2px] rounded-full text-xs bg-surface-container-highest text-on-surface-variant capitalize">
            {analysis.confidence || 'n/a'} confidence
          </span>
        </div>
      </div>
      {analysis.trend_summary && <p className="text-sm text-on-surface">{analysis.trend_summary}</p>}
      {analysis.momentum_assessment && <p className="text-sm text-on-surface-variant">{analysis.momentum_assessment}</p>}
      {Array.isArray(analysis.key_levels) && analysis.key_levels.length > 0 && (
        <div className="flex flex-col gap-xs">
          <span className="text-xs text-on-surface-variant uppercase">Key Levels</span>
          <ul className="flex flex-col gap-[2px]">
            {analysis.key_levels.map((level, i) => (
              <li key={i} className="text-sm text-on-surface">
                <span className={level.type === 'support' ? 'text-bullish' : 'text-bearish'}>{level.type}</span> {level.price}
                {level.note ? ` — ${level.note}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
      {Array.isArray(analysis.risk_factors) && analysis.risk_factors.length > 0 && (
        <div className="flex flex-col gap-xs">
          <span className="text-xs text-on-surface-variant uppercase">Risk Factors</span>
          <ul className="list-disc list-inside">
            {analysis.risk_factors.map((risk, i) => (
              <li key={i} className="text-sm text-on-surface-variant">
                {risk}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function HistoricalChartTab({ instanceKey = 'primary' }) {
  const { stateKey, actions } = CHART_INSTANCES[instanceKey]
  const dispatch = useDispatch()
  const selectedSymbol = useSelector((state) => state[stateKey].selectedSymbol)
  const exchange = useSelector((state) => state[stateKey].exchange)
  const interval = useSelector((state) => state[stateKey].interval)
  const startTime = useSelector((state) => state[stateKey].startTime)
  const endTime = useSelector((state) => state[stateKey].endTime)
  const indicatorConfig = useSelector((state) => state[stateKey].indicatorConfig)
  const watchlistEntries = useSelector((state) => state.historicalWatchlist.entries)

  const [candles, setCandles] = useState([])
  const [indicatorSeries, setIndicatorSeries] = useState({})
  const [loading, setLoading] = useState(false)
  const [indicatorsLoading, setIndicatorsLoading] = useState(false)
  const [error, setError] = useState('')

  const [aiInsight, setAiInsight] = useState(null)
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState('')

  const [watchlistBusy, setWatchlistBusy] = useState(false)
  const [watchlistError, setWatchlistError] = useState('')

  // Debounced (300ms) instrument search-by-symbol-or-name, backing the
  // AsyncSelect below - avoids firing a request on every keystroke.
  const searchTimeoutRef = useRef(null)
  const loadSymbolOptions = useCallback((inputValue, callback) => {
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current)
    if (!inputValue || inputValue.trim().length === 0) {
      callback([])
      return
    }
    searchTimeoutRef.current = setTimeout(() => {
      searchInstruments(inputValue)
        .then(({ results }) => callback((results || []).map((r) => ({ value: r.symbol, label: `${r.symbol} — ${r.name}` }))))
        .catch((err) => {
          console.error('Instrument search failed:', err)
          callback([])
        })
    }, 300)
  }, [])

  useEffect(() => {
    getHistoricalWatchlistEntries()
      .then(({ entries }) => dispatch(setHistoricalWatchlistEntries(entries || [])))
      .catch((err) => console.error('Failed to load historical watchlist entries:', err))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Fills in an interval-appropriate default range the first time this
  // instance has no range yet (fresh install, or a persisted-empty state),
  // and re-derives it whenever the interval GENUINELY CHANGES afterward - a
  // range picked for "1 day" candles is the wrong scale once you switch to
  // "1 minute". Tracks the previous interval via a ref (compared against the
  // current one) rather than a one-shot "isFirstRender" boolean - the latter
  // permanently flips to the unconditional-reset branch after its first run,
  // which is fine on a true first-ever mount (startTime/endTime are already
  // empty then, so both branches agree) but silently WIPED an already-set
  // range every time a Chart tab was switched away from and back to (each
  // switch fully unmounts/remounts this component - see App.jsx's
  // TAB_COMPONENTS - so a fresh "isFirstRender" ref taking the unconditional
  // branch on React 18 StrictMode's dev-only double-invoked effect pass
  // clobbered the real, already-persisted startTime/endTime with a
  // freshly-computed "now"-based default). Comparing against the previous
  // interval is immune to that: on remount, the ref's initial value already
  // equals the current interval, so neither branch fires unless the user
  // actually changed the dropdown. Does NOT reset on symbol/exchange changes
  // - only the interval determines what "a reasonable window" means.
  const previousInterval = useRef(interval)
  useEffect(() => {
    if (!startTime || !endTime) {
      const defaults = computeDefaultRange(interval)
      dispatch(actions.setStartTime(defaults.startTime))
      dispatch(actions.setEndTime(defaults.endTime))
      previousInterval.current = interval
      return
    }
    if (previousInterval.current !== interval) {
      const defaults = computeDefaultRange(interval)
      dispatch(actions.setStartTime(defaults.startTime))
      dispatch(actions.setEndTime(defaults.endTime))
      previousInterval.current = interval
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interval, startTime, endTime])

  useEffect(() => {
    if (!selectedSymbol || !startTime || !endTime) {
      setCandles([])
      return
    }
    let cancelled = false
    setLoading(true)
    setError('')
    getHistoricalCandles(selectedSymbol, { exchange, interval, startTime, endTime })
      .then(({ candles: fetched }) => {
        if (!cancelled) setCandles(fetched || [])
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.response?.data?.error || err.message || 'Failed to load historical data')
          setCandles([])
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selectedSymbol, exchange, interval, startTime, endTime])

  useEffect(() => {
    if (!selectedSymbol || candles.length === 0) {
      setIndicatorSeries({})
      return
    }
    const specs = buildIndicatorSpecs(indicatorConfig)
    if (specs.length === 0) {
      setIndicatorSeries({})
      return
    }
    let cancelled = false
    setIndicatorsLoading(true)
    getIndicatorSeries(selectedSymbol, { exchange, interval, startTime, endTime, indicators: specs.join(',') })
      .then(({ series }) => {
        if (!cancelled) setIndicatorSeries(series || {})
      })
      .catch((err) => {
        if (!cancelled) console.error('Failed to load indicator series:', err)
      })
      .finally(() => {
        if (!cancelled) setIndicatorsLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSymbol, exchange, interval, startTime, endTime, candles, indicatorConfig])

  const handleAiInsight = () => {
    if (!selectedSymbol || candles.length === 0) return
    setAiLoading(true)
    setAiError('')
    setAiInsight(null)
    const specs = buildIndicatorSpecs(indicatorConfig)
    getHistoricalAiInsight(selectedSymbol, { exchange, interval, startTime, endTime, indicators: specs.join(',') })
      .then((result) => setAiInsight(result))
      .catch((err) => setAiError(err.response?.data?.error || err.message || 'Failed to get AI insight'))
      .finally(() => setAiLoading(false))
  }

  const alreadyWatched = watchlistEntries.some((e) => e.symbol === selectedSymbol && e.exchange === exchange && e.interval === interval)

  const handleAddToWatchlist = () => {
    if (!selectedSymbol) return
    setWatchlistBusy(true)
    setWatchlistError('')
    addHistoricalWatchlistEntry({ symbol: selectedSymbol, exchange, interval, indicatorSpecs: buildIndicatorSpecs(indicatorConfig) })
      .then(() => getHistoricalWatchlistEntries())
      .then(({ entries }) => dispatch(setHistoricalWatchlistEntries(entries || [])))
      .catch((err) => setWatchlistError(err.response?.data?.error || err.message || 'Failed to add to watchlist'))
      .finally(() => setWatchlistBusy(false))
  }

  const handleRemoveFromWatchlist = (id) => {
    setWatchlistBusy(true)
    setWatchlistError('')
    removeHistoricalWatchlistEntry(id)
      .then(() => getHistoricalWatchlistEntries())
      .then(({ entries }) => dispatch(setHistoricalWatchlistEntries(entries || [])))
      .catch((err) => setWatchlistError(err.response?.data?.error || err.message || 'Failed to remove from watchlist'))
      .finally(() => setWatchlistBusy(false))
  }

  return (
    <div className="flex flex-col gap-lg">
      <div className="glass-panel p-md rounded-xl flex items-end gap-lg flex-wrap">
        <div className="flex flex-col gap-xs">
          <label className="text-[11px] uppercase text-on-surface-variant" htmlFor={`hc-exchange-${instanceKey}`}>
            Exchange
          </label>
          <select
            id={`hc-exchange-${instanceKey}`}
            value={exchange}
            onChange={(e) => dispatch(actions.setExchange(e.target.value))}
            disabled={loading}
            className="bg-surface-container-low border border-terminal-border rounded-lg text-sm px-md py-base min-w-[120px] text-on-surface disabled:opacity-50"
          >
            <option value="NSE">NSE</option>
            <option value="BSE">BSE</option>
          </select>
        </div>

        <div className="flex flex-col gap-xs">
          <label className="text-[11px] uppercase text-on-surface-variant" htmlFor={`hc-symbol-${instanceKey}`}>
            Symbol
          </label>
          <AsyncSelect
            inputId={`hc-symbol-${instanceKey}`}
            unstyled
            isClearable
            isDisabled={loading}
            loadOptions={loadSymbolOptions}
            defaultOptions={false}
            value={selectedSymbol ? { value: selectedSymbol, label: selectedSymbol } : null}
            onChange={(selected) => dispatch(actions.setSelectedSymbol(selected?.value || ''))}
            placeholder="Search symbol or company name..."
            noOptionsMessage={({ inputValue }) => (inputValue ? 'No matches' : 'Type to search')}
            classNames={underlyingSymbolSelectClassNames}
            menuPortalTarget={document.body}
          />
        </div>

        <div className="flex flex-col gap-xs">
          <label className="text-[11px] uppercase text-on-surface-variant" htmlFor={`hc-interval-${instanceKey}`}>
            Interval
          </label>
          <select
            id={`hc-interval-${instanceKey}`}
            value={interval}
            onChange={(e) => dispatch(actions.setInterval(e.target.value))}
            disabled={loading}
            className="bg-surface-container-low border border-terminal-border rounded-lg text-sm px-md py-base min-w-[120px] text-on-surface disabled:opacity-50"
          >
            {INTERVAL_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-xs">
          <label className="text-[11px] uppercase text-on-surface-variant" htmlFor={`hc-start-${instanceKey}`}>
            Start
          </label>
          <input
            id={`hc-start-${instanceKey}`}
            type="datetime-local"
            value={startTime}
            onChange={(e) => dispatch(actions.setStartTime(e.target.value))}
            disabled={loading}
            className="bg-surface-container-low border border-terminal-border rounded-lg text-sm px-md py-base text-on-surface disabled:opacity-50"
          />
        </div>

        <div className="flex flex-col gap-xs">
          <label className="text-[11px] uppercase text-on-surface-variant" htmlFor={`hc-end-${instanceKey}`}>
            End
          </label>
          <input
            id={`hc-end-${instanceKey}`}
            type="datetime-local"
            value={endTime}
            onChange={(e) => dispatch(actions.setEndTime(e.target.value))}
            disabled={loading}
            className="bg-surface-container-low border border-terminal-border rounded-lg text-sm px-md py-base text-on-surface disabled:opacity-50"
          />
        </div>

        {selectedSymbol && (
          <button
            type="button"
            onClick={alreadyWatched ? undefined : handleAddToWatchlist}
            disabled={watchlistBusy || alreadyWatched}
            className="px-md py-base rounded-lg text-sm bg-surface-container-highest text-on-surface disabled:opacity-50 disabled:cursor-default hover:bg-surface-container-high"
          >
            {alreadyWatched ? 'In Watchlist' : 'Add to Watchlist'}
          </button>
        )}

        {selectedSymbol && candles.length > 0 && (
          <button
            type="button"
            onClick={handleAiInsight}
            disabled={aiLoading}
            className="px-md py-base rounded-lg text-sm bg-primary-container text-on-primary-container disabled:opacity-50 hover:opacity-90 flex items-center gap-xs"
          >
            {aiLoading && <Spinner />}
            AI Insight
          </button>
        )}

        {(loading || indicatorsLoading) && (
          <div className="flex items-center gap-xs text-xs text-on-surface-variant pb-[10px]">
            <Spinner />
            {loading ? 'Loading candles...' : 'Updating indicators...'}
          </div>
        )}
      </div>

      {watchlistError && <div className="text-xs text-error px-xs">{watchlistError}</div>}

      {watchlistEntries.length > 0 && (
        <div className="glass-panel p-md rounded-xl flex flex-col gap-sm">
          <h4 className="text-xs font-medium text-on-surface-variant uppercase">Historical Watchlist</h4>
          <div className="flex flex-wrap gap-sm">
            {watchlistEntries.map((entry) => (
              <div key={entry.id} className="flex items-center gap-xs px-sm py-[4px] rounded-lg bg-surface-container-highest text-sm text-on-surface">
                <span>
                  {entry.symbol} · {entry.exchange} · {entry.interval}
                </span>
                {entry.lastError && <span className="text-error text-xs" title={entry.lastError.message}>⚠</span>}
                <button
                  type="button"
                  onClick={() => handleRemoveFromWatchlist(entry.id)}
                  disabled={watchlistBusy}
                  className="text-on-surface-variant hover:text-error disabled:opacity-50"
                  aria-label={`Remove ${entry.symbol} from watchlist`}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="glass-panel p-md rounded-xl flex flex-col gap-sm">
        <h4 className="text-xs font-medium text-on-surface-variant uppercase">Indicators</h4>
        {INDICATOR_ROWS.map((row) => (
          <IndicatorControlRow
            key={row.key}
            row={row}
            config={indicatorConfig[row.key]}
            onChange={(changes) => dispatch(actions.setIndicatorConfig({ key: row.key, changes }))}
          />
        ))}
      </div>

      {aiError && <div className="glass-panel p-md rounded-xl text-sm text-error">{aiError}</div>}
      {aiInsight && <AiInsightCard insight={aiInsight} />}

      {!selectedSymbol && (
        <div className="glass-panel p-xl rounded-xl text-center text-on-surface-variant text-sm">Search for a symbol above to load its chart.</div>
      )}
      {selectedSymbol && loading && candles.length === 0 && (
        <div className="glass-panel p-xl rounded-xl flex items-center justify-center gap-sm text-on-surface-variant text-sm">
          <Spinner />
          Loading historical data...
        </div>
      )}
      {selectedSymbol && error && (
        <div className="glass-panel p-xl rounded-xl text-center text-error text-sm">{error}</div>
      )}
      {selectedSymbol && candles.length > 0 && (
        <div className="glass-panel p-md rounded-xl relative">
          {(loading || indicatorsLoading) && (
            <div className="absolute inset-0 bg-surface/40 rounded-xl flex items-start justify-center pt-xl z-10">
              <div className="glass-panel px-md py-sm rounded-lg flex items-center gap-sm text-sm text-on-surface">
                <Spinner />
                {loading ? 'Refreshing chart...' : 'Updating indicators...'}
              </div>
            </div>
          )}
          <HistoricalCandlestickChart candles={candles} indicatorSeries={indicatorSeries} indicatorConfig={indicatorConfig} />
        </div>
      )}
    </div>
  )
}

export default HistoricalChartTab
