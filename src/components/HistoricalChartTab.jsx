/**
 * Historical Chart tab - lets the user pick any of the 269 underlying
 * symbols (same list as Greek Analysis, not limited to the Watchlist) plus
 * exchange/interval, fetches OHLC candles (stored server-side in Firestore,
 * fetched from Groww only for what's missing/stale - see
 * functions/growwHistoricalData.js), then optionally computes+stores and
 * renders technical indicators alongside the price chart.
 */
import { useEffect, useRef, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import Select from 'react-select'
import { getUnderlyingSymbols, getHistoricalCandles, getIndicatorSeries } from '../services/api'
import { setSelectedSymbol, setExchange, setInterval as setChartInterval, setStartTime, setEndTime, setIndicatorConfig } from '../store/historicalChartSlice'
import HistoricalCandlestickChart from './HistoricalCandlestickChart'
import Spinner from './Spinner'

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
]

function buildIndicatorSpecs(indicatorConfig) {
  const specs = []
  if (indicatorConfig.sma.enabled) specs.push(`SMA:${indicatorConfig.sma.period}`)
  if (indicatorConfig.ema.enabled) specs.push(`EMA:${indicatorConfig.ema.period}`)
  if (indicatorConfig.bollingerBands.enabled) specs.push(`BB:${indicatorConfig.bollingerBands.period}:${indicatorConfig.bollingerBands.stdDev}`)
  if (indicatorConfig.rsi.enabled) specs.push(`RSI:${indicatorConfig.rsi.period}`)
  if (indicatorConfig.macd.enabled) specs.push(`MACD:${indicatorConfig.macd.fastPeriod}:${indicatorConfig.macd.slowPeriod}:${indicatorConfig.macd.signalPeriod}`)
  return specs
}

function IndicatorControlRow({ row, config, onChange }) {
  return (
    <div className="flex items-center gap-sm flex-wrap">
      <label className="flex items-center gap-xs text-sm text-on-surface min-w-[140px]">
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

function HistoricalChartTab() {
  const dispatch = useDispatch()
  const selectedSymbol = useSelector((state) => state.historicalChart.selectedSymbol)
  const exchange = useSelector((state) => state.historicalChart.exchange)
  const interval = useSelector((state) => state.historicalChart.interval)
  const startTime = useSelector((state) => state.historicalChart.startTime)
  const endTime = useSelector((state) => state.historicalChart.endTime)
  const indicatorConfig = useSelector((state) => state.historicalChart.indicatorConfig)

  const [underlyingSymbolOptions, setUnderlyingSymbolOptions] = useState([])
  const [candles, setCandles] = useState([])
  const [indicatorSeries, setIndicatorSeries] = useState({})
  const [loading, setLoading] = useState(false)
  const [indicatorsLoading, setIndicatorsLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    getUnderlyingSymbols()
      .then(({ symbols }) => setUnderlyingSymbolOptions((symbols || []).map((symbol) => ({ value: symbol, label: symbol }))))
      .catch((err) => console.error('Failed to load underlying symbols:', err))
  }, [])

  // Fills in an interval-appropriate default range on first mount (only if
  // nothing was persisted from a previous session), and re-derives it
  // whenever the interval changes afterward - a range picked for "1 day"
  // candles is the wrong scale once you switch to "1 minute" (likely empty
  // or over that interval's own max-span cap), so re-anchor it rather than
  // leaving a stale range in place. Does NOT reset on
  // symbol/exchange changes - only the interval determines what "a
  // reasonable window" means.
  const isFirstRender = useRef(true)
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false
      if (!startTime || !endTime) {
        const defaults = computeDefaultRange(interval)
        dispatch(setStartTime(defaults.startTime))
        dispatch(setEndTime(defaults.endTime))
      }
      return
    }
    const defaults = computeDefaultRange(interval)
    dispatch(setStartTime(defaults.startTime))
    dispatch(setEndTime(defaults.endTime))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interval])

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

  return (
    <div className="flex flex-col gap-lg">
      <div className="glass-panel p-md rounded-xl flex items-end gap-lg flex-wrap">
        <div className="flex flex-col gap-xs">
          <label className="text-[11px] uppercase text-on-surface-variant" htmlFor="hc-exchange">
            Exchange
          </label>
          <select
            id="hc-exchange"
            value={exchange}
            onChange={(e) => dispatch(setExchange(e.target.value))}
            disabled={loading}
            className="bg-surface-container-low border border-terminal-border rounded-lg text-sm px-md py-base min-w-[120px] text-on-surface disabled:opacity-50"
          >
            <option value="NSE">NSE</option>
            <option value="BSE">BSE</option>
          </select>
        </div>

        <div className="flex flex-col gap-xs">
          <label className="text-[11px] uppercase text-on-surface-variant" htmlFor="hc-symbol">
            Symbol
          </label>
          <Select
            inputId="hc-symbol"
            unstyled
            isClearable
            isDisabled={loading}
            options={underlyingSymbolOptions}
            value={selectedSymbol ? { value: selectedSymbol, label: selectedSymbol } : null}
            onChange={(selected) => dispatch(setSelectedSymbol(selected?.value || ''))}
            placeholder="e.g., NIFTY"
            classNames={underlyingSymbolSelectClassNames}
            menuPortalTarget={document.body}
          />
        </div>

        <div className="flex flex-col gap-xs">
          <label className="text-[11px] uppercase text-on-surface-variant" htmlFor="hc-interval">
            Interval
          </label>
          <select
            id="hc-interval"
            value={interval}
            onChange={(e) => dispatch(setChartInterval(e.target.value))}
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
          <label className="text-[11px] uppercase text-on-surface-variant" htmlFor="hc-start">
            Start
          </label>
          <input
            id="hc-start"
            type="datetime-local"
            value={startTime}
            onChange={(e) => dispatch(setStartTime(e.target.value))}
            disabled={loading}
            className="bg-surface-container-low border border-terminal-border rounded-lg text-sm px-md py-base text-on-surface disabled:opacity-50"
          />
        </div>

        <div className="flex flex-col gap-xs">
          <label className="text-[11px] uppercase text-on-surface-variant" htmlFor="hc-end">
            End
          </label>
          <input
            id="hc-end"
            type="datetime-local"
            value={endTime}
            onChange={(e) => dispatch(setEndTime(e.target.value))}
            disabled={loading}
            className="bg-surface-container-low border border-terminal-border rounded-lg text-sm px-md py-base text-on-surface disabled:opacity-50"
          />
        </div>

        {(loading || indicatorsLoading) && (
          <div className="flex items-center gap-xs text-xs text-on-surface-variant pb-[10px]">
            <Spinner />
            {loading ? 'Loading candles...' : 'Updating indicators...'}
          </div>
        )}
      </div>

      <div className="glass-panel p-md rounded-xl flex flex-col gap-sm">
        <h4 className="text-xs font-medium text-on-surface-variant uppercase">Indicators</h4>
        {INDICATOR_ROWS.map((row) => (
          <IndicatorControlRow
            key={row.key}
            row={row}
            config={indicatorConfig[row.key]}
            onChange={(changes) => dispatch(setIndicatorConfig({ key: row.key, changes }))}
          />
        ))}
      </div>

      {!selectedSymbol && (
        <div className="glass-panel p-xl rounded-xl text-center text-on-surface-variant text-sm">Pick a symbol above to load its chart.</div>
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
