/**
 * Historical Chart tab - lets the user pick any of the same underlying
 * symbols as the Greek Analysis tab (same source, same list - see
 * getUnderlyingSymbols() below) plus exchange/interval, fetches OHLC
 * candles (stored server-side in Firestore, fetched from Groww only for
 * what's missing/stale - see functions/growwHistoricalData.js), then
 * optionally computes+stores and renders technical indicators alongside
 * the price chart. Also offers an on-demand AI insight over whatever's
 * currently loaded, and lets the current symbol/exchange/interval be added
 * to the Historical Watchlist for automated background refresh
 * (functions/historicalWatchlistScheduler.js).
 *
 * Mounted twice (App.jsx's 'chart' and 'chart2' tabs) with different
 * `instanceKey` props so each copy keeps fully independent state - see
 * CHART_INSTANCES below and src/store/historicalChartSlice.js's factory.
 */
import { useEffect, useRef, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import Select from 'react-select'
import DatePicker from 'react-datepicker'
import screenfull from 'screenfull'
import 'react-datepicker/dist/react-datepicker.css'
import {
  getUnderlyingSymbols,
  getHistoricalCandles,
  getIndicatorSeries,
  getHistoricalAiInsight,
  addHistoricalWatchlistEntry,
  getHistoricalWatchlistEntries,
  removeHistoricalWatchlistEntry,
  getHistoricalWatchlistAnalysis,
  generateHistoricalWatchlistInsight,
} from '../services/api'
import { historicalChartPrimarySlice, historicalChartSecondarySlice } from '../store/index'
import { setHistoricalWatchlistEntries } from '../store/historicalWatchlistSlice'
import HistoricalCandlestickChart from './HistoricalCandlestickChart'
import Spinner from './Spinner'

const CHART_INSTANCES = {
  primary: { stateKey: 'historicalChartPrimary', actions: historicalChartPrimarySlice.actions },
  secondary: { stateKey: 'historicalChartSecondary', actions: historicalChartSecondarySlice.actions },
}

// Every `.glass-panel` in this app (including the filter bar these pickers
// live in) sets backdrop-filter, which creates its own CSS stacking context.
// Left un-portaled, react-datepicker's popup renders as a normal descendant
// of that context and overflows below the filter bar's own box - visually
// landing on top of the Indicators panel underneath, but PAINTED first
// (same stack level, earlier DOM position), so that later glass-panel's own
// stacking context covers the overflowing part of the calendar. Portaling
// to document.body sidesteps the whole local stacking context.
const DATEPICKER_PORTAL_ID = 'hc-datepicker-portal'

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

// Rebuilds the same 'YYYY-MM-DDTHH:mm' shape from a Date the calendar picker
// hands back, reading its LOCAL y/m/d/h/mi fields directly (no Intl/timezone
// math, unlike formatIstForInput above). startTime/endTime are timezone-naive
// IST wall-clock strings (see formatIstForInput's comment); a Date built from
// one of those strings via `new Date(str)` and read back through its local
// getters reproduces the identical string on any browser timezone, since
// both the construction and this extraction consistently use the browser's
// own local interpretation - no real IST conversion needed here.
function formatPickerValue(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// Blocks typed edits to the Start/End calendar inputs while leaving calendar
// day/time-list clicks untouched - react-datepicker's own `readOnly` prop
// looks like the obvious fit but also disables day selection entirely (see
// its handleSelect: `if (props.readOnly) return`), which would break the
// picker outright. `onChangeRaw` only gates the input's native onChange (i.e.
// actual keystrokes) - calling preventDefault() there makes handleChange
// bail out before it parses/applies the typed text, while handleSelect
// (calendar clicks) never checks it and keeps working normally.
function blockTypedDateInput(event) {
  event?.preventDefault?.()
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
  { key: 'rsiDivergence', label: 'RSI Divergence', fields: [{ name: 'rsiPeriod', label: 'RSI' }, { name: 'lookback', label: 'Lookback' }] },
  {
    key: 'macdCrossover',
    label: 'MACD Crossover',
    fields: [{ name: 'fastPeriod', label: 'Fast' }, { name: 'slowPeriod', label: 'Slow' }, { name: 'signalPeriod', label: 'Signal' }],
  },
  {
    key: 'tsiCrossover',
    label: 'TSI Crossover',
    fields: [{ name: 'longPeriod', label: 'Long' }, { name: 'shortPeriod', label: 'Short' }, { name: 'signalPeriod', label: 'Signal' }],
  },
  {
    key: 'stochRsiCrossover',
    label: 'Stoch RSI Crossover',
    fields: [
      { name: 'rsiPeriod', label: 'RSI' },
      { name: 'stochasticPeriod', label: 'Stoch' },
      { name: 'kPeriod', label: 'K' },
      { name: 'dPeriod', label: 'D' },
    ],
  },
  { key: 'adxCrossover', label: 'ADX Crossover', fields: [{ name: 'period', label: 'Period' }] },
  { key: 'smaCrossover', label: 'SMA Crossover', fields: [{ name: 'fastPeriod', label: 'Fast' }, { name: 'slowPeriod', label: 'Slow' }] },
  { key: 'emaCrossover', label: 'EMA Crossover', fields: [{ name: 'fastPeriod', label: 'Fast' }, { name: 'slowPeriod', label: 'Slow' }] },
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
  if (indicatorConfig.rsiDivergence.enabled) specs.push(`RSIDIV:${indicatorConfig.rsiDivergence.rsiPeriod}:${indicatorConfig.rsiDivergence.lookback}`)
  if (indicatorConfig.macdCrossover.enabled) {
    const { fastPeriod, slowPeriod, signalPeriod } = indicatorConfig.macdCrossover
    specs.push(`MACDCROSS:${fastPeriod}:${slowPeriod}:${signalPeriod}`)
  }
  if (indicatorConfig.tsiCrossover.enabled) {
    const { longPeriod, shortPeriod, signalPeriod } = indicatorConfig.tsiCrossover
    specs.push(`TSICROSS:${longPeriod}:${shortPeriod}:${signalPeriod}`)
  }
  if (indicatorConfig.stochRsiCrossover.enabled) {
    const { rsiPeriod, stochasticPeriod, kPeriod, dPeriod } = indicatorConfig.stochRsiCrossover
    specs.push(`STOCHRSICROSS:${rsiPeriod}:${stochasticPeriod}:${kPeriod}:${dPeriod}`)
  }
  if (indicatorConfig.adxCrossover.enabled) specs.push(`ADXCROSS:${indicatorConfig.adxCrossover.period}`)
  if (indicatorConfig.smaCrossover.enabled) specs.push(`SMACROSS:${indicatorConfig.smaCrossover.fastPeriod}:${indicatorConfig.smaCrossover.slowPeriod}`)
  if (indicatorConfig.emaCrossover.enabled) specs.push(`EMACROSS:${indicatorConfig.emaCrossover.fastPeriod}:${indicatorConfig.emaCrossover.slowPeriod}`)
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

function AiInsightCard({ insight, title = 'AI Insight' }) {
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
        <h4 className="text-xs font-medium text-on-surface-variant uppercase">{title}</h4>
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

function formatDivergenceDate(timestampSeconds) {
  return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }).format(
    new Date(timestampSeconds * 1000)
  )
}

// Same relative-time formatting as AppShell's NotificationBell - kept as a
// small local copy rather than a new shared-utils module for one reuse.
function timeAgo(isoString) {
  if (!isoString) return ''
  const diffMs = Date.now() - new Date(isoString).getTime()
  const minutes = Math.floor(diffMs / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

// One row per detected event - drives both the price-panel lines
// (HistoricalCandlestickChart.jsx) and this card, both reading the exact
// same indicatorSeries['RSIDIV:...'] array so they never disagree.
function DivergenceCard({ events }) {
  const bullishCount = events.filter((e) => e.value.type === 'bullish').length
  const bearishCount = events.length - bullishCount

  return (
    <div className="glass-panel p-md rounded-xl flex flex-col gap-sm">
      <div className="flex items-center justify-between flex-wrap gap-sm">
        <h4 className="text-xs font-medium text-on-surface-variant uppercase">RSI Divergence</h4>
        <div className="flex items-center gap-xs text-xs">
          <span className="px-sm py-[2px] rounded-full bg-bullish/15 text-bullish font-medium">{bullishCount} Bullish</span>
          <span className="px-sm py-[2px] rounded-full bg-bearish/15 text-bearish font-medium">{bearishCount} Bearish</span>
        </div>
      </div>
      {events.length === 0 ? (
        <p className="text-sm text-on-surface-variant">No divergence detected over the loaded range.</p>
      ) : (
        <ul className="flex flex-col gap-xs">
          {[...events].reverse().map((event, i) => {
            const { type, startTimestamp, startPrice, startRsi, endTimestamp, endPrice, endRsi } = event.value
            const isBullish = type === 'bullish'
            return (
              <li key={i} className="flex items-center justify-between gap-sm text-sm border-t border-terminal-border pt-xs first:border-t-0 first:pt-0">
                <span className={`font-medium capitalize ${isBullish ? 'text-bullish' : 'text-bearish'}`}>{type}</span>
                <span className="text-on-surface-variant text-xs">
                  {formatDivergenceDate(startTimestamp)} → {formatDivergenceDate(endTimestamp)}
                </span>
                <span className="text-on-surface text-xs">
                  Price {startPrice.toFixed(2)} → {endPrice.toFixed(2)}
                </span>
                <span className="text-on-surface text-xs">
                  RSI {startRsi.toFixed(1)} → {endRsi.toFixed(1)}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

// One row per detected event - drives both the price/oscillator-panel
// markers (HistoricalCandlestickChart.jsx) and this card, both reading the
// exact same indicatorSeries[...] array so they never disagree. Shared by
// every crossover type (MACD/TSI/Stoch RSI/ADX/SMA/EMA) - `title` and
// `formatDetail(value)` let each caller supply its own heading and detail
// line (e.g. "+DI / -DI" for ADX) without duplicating this card six times.
function CrossoverCard({ events, title, formatDetail }) {
  const bullishCount = events.filter((e) => e.value.type === 'bullish').length
  const bearishCount = events.length - bullishCount

  return (
    <div className="glass-panel p-md rounded-xl flex flex-col gap-sm">
      <div className="flex items-center justify-between flex-wrap gap-sm">
        <h4 className="text-xs font-medium text-on-surface-variant uppercase">{title}</h4>
        <div className="flex items-center gap-xs text-xs">
          <span className="px-sm py-[2px] rounded-full bg-bullish/15 text-bullish font-medium">{bullishCount} Bullish</span>
          <span className="px-sm py-[2px] rounded-full bg-bearish/15 text-bearish font-medium">{bearishCount} Bearish</span>
        </div>
      </div>
      {events.length === 0 ? (
        <p className="text-sm text-on-surface-variant">No crossover detected over the loaded range.</p>
      ) : (
        <ul className="flex flex-col gap-xs">
          {[...events].reverse().map((event, i) => {
            const { type, price } = event.value
            const isBullish = type === 'bullish'
            return (
              <li key={i} className="flex items-center justify-between gap-sm text-sm border-t border-terminal-border pt-xs first:border-t-0 first:pt-0">
                <span className={`font-medium capitalize ${isBullish ? 'text-bullish' : 'text-bearish'}`}>{type}</span>
                <span className="text-on-surface-variant text-xs">{formatDivergenceDate(event.timestamp)}</span>
                <span className="text-on-surface text-xs">Price {price.toFixed(2)}</span>
                <span className="text-on-surface text-xs">{formatDetail(event.value)}</span>
              </li>
            )
          })}
        </ul>
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

  const [automatedInsight, setAutomatedInsight] = useState(null)

  const [watchlistBusy, setWatchlistBusy] = useState(false)
  const [watchlistError, setWatchlistError] = useState('')
  const [insightGeneratingId, setInsightGeneratingId] = useState(null)
  const [insightGenError, setInsightGenError] = useState('')

  const [underlyingSymbolOptions, setUnderlyingSymbolOptions] = useState([])

  const [isFullscreen, setIsFullscreen] = useState(false)
  const chartPanelRef = useRef(null)
  // Invalidates any in-flight handleFetch() response so a stale reply (a slow
  // request superseded by a newer click, or one that resolves after unmount)
  // never overwrites state - mirrors the `cancelled` closure flag the old
  // auto-fetching effect used, just re-shaped for a manual click handler
  // instead of an effect cleanup.
  const fetchToken = useRef(0)
  useEffect(() => () => { fetchToken.current += 1 }, [])

  // Same source/list as the Greek Analysis tab's own symbol picker - kept in
  // sync deliberately (getUnderlyingSymbols() is the one canonical
  // underlying-symbol list the whole app shares) rather than the broader
  // per-instrument search this tab used briefly (functions/instrumentMasterSync.js's
  // /instrument-search route still exists and works, just isn't used here
  // anymore - nothing currently calls it, but it's left in place rather than
  // torn out since removing it wasn't asked for).
  useEffect(() => {
    getUnderlyingSymbols()
      .then(({ symbols }) => setUnderlyingSymbolOptions((symbols || []).map((symbol) => ({ value: symbol, label: symbol }))))
      .catch((err) => console.error('Failed to load underlying symbols:', err))
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

  // Candle fetching is manual now (see handleFetch below, wired to the
  // "Fetch Data" button) - editing any filter no longer hits the API on its
  // own. This effect only clears out the now-stale chart/error for the
  // *previous* symbol/exchange/interval so it doesn't keep looking "live"
  // after the user changes one of those - it never calls the API itself.
  // Deliberately excludes startTime/endTime: adjusting the date range alone
  // shouldn't blank the currently-displayed chart, only a Fetch click should
  // replace it.
  useEffect(() => {
    setCandles([])
    setIndicatorSeries({})
    setError('')
  }, [selectedSymbol, exchange, interval])

  const handleFetch = () => {
    if (!selectedSymbol || !startTime || !endTime) return
    const requestId = ++fetchToken.current
    setLoading(true)
    setError('')
    getHistoricalCandles(selectedSymbol, { exchange, interval, startTime, endTime })
      .then(({ candles: fetched }) => {
        if (fetchToken.current !== requestId) return
        setCandles(fetched || [])
      })
      .catch((err) => {
        if (fetchToken.current !== requestId) return
        setError(err.response?.data?.error || err.message || 'Failed to load historical data')
        setCandles([])
      })
      .finally(() => {
        if (fetchToken.current !== requestId) return
        setLoading(false)
      })
  }

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
  const watchedEntry = watchlistEntries.find((e) => e.symbol === selectedSymbol && e.exchange === exchange && e.interval === interval)

  // The Historical Watchlist automation (functions/historicalWatchlistScheduler.js)
  // only refreshes candle/indicator data now - AI insight for a watched
  // entry is generated on demand (see the per-chip button below,
  // handleGenerateInsight) and shown here via the same AiInsightCard the
  // manual button uses, fed by whatever was last generated for this entry.
  useEffect(() => {
    if (!watchedEntry) {
      setAutomatedInsight(null)
      return
    }
    let cancelled = false
    getHistoricalWatchlistAnalysis(watchedEntry.id)
      .then(({ analysis }) => {
        if (!cancelled) setAutomatedInsight(analysis)
      })
      .catch((err) => console.error('Failed to load automated AI insight:', err))
    return () => {
      cancelled = true
    }
  }, [watchedEntry?.id])

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

  // Generates a fresh AI insight for one watched entry - the only way this
  // feature calls AI now that the background job is pure data-refresh. If
  // the entry being generated for is also the one currently loaded in the
  // chart, updates automatedInsight directly so the card refreshes without
  // a second round-trip read.
  const handleGenerateInsight = (entry) => {
    setInsightGeneratingId(entry.id)
    setInsightGenError('')
    generateHistoricalWatchlistInsight(entry.id)
      .then(({ analysis }) => {
        if (watchedEntry?.id === entry.id) setAutomatedInsight(analysis)
      })
      .catch((err) => setInsightGenError(err.response?.data?.error || err.message || 'Failed to generate AI insight'))
      .finally(() => setInsightGeneratingId(null))
  }

  // Keeps isFullscreen in sync when the browser exits fullscreen outside our
  // own toggle button (Esc key, browser chrome) - screenfull normalizes this
  // across browsers' prefixed fullscreenchange events into one 'change' event.
  useEffect(() => {
    if (!screenfull.isEnabled) return
    const onChange = () => setIsFullscreen(screenfull.isFullscreen)
    screenfull.on('change', onChange)
    return () => screenfull.off('change', onChange)
  }, [])

  const handleToggleFullscreen = () => {
    if (!screenfull.isEnabled || !chartPanelRef.current) return
    screenfull.toggle(chartPanelRef.current)
    // Plotly's useResizeHandler listens for the window 'resize' event, which
    // a Fullscreen API transition doesn't always fire on its own - nudge it
    // once the transition settles so the plot actually fills the new size.
    window.setTimeout(() => window.dispatchEvent(new Event('resize')), 50)
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
          <Select
            inputId={`hc-symbol-${instanceKey}`}
            unstyled
            isClearable
            isDisabled={loading}
            options={underlyingSymbolOptions}
            value={selectedSymbol ? { value: selectedSymbol, label: selectedSymbol } : null}
            onChange={(selected) => dispatch(actions.setSelectedSymbol(selected?.value || ''))}
            placeholder="e.g., NIFTY"
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
          <DatePicker
            id={`hc-start-${instanceKey}`}
            selected={startTime ? new Date(startTime) : null}
            onChange={(date) => date && dispatch(actions.setStartTime(formatPickerValue(date)))}
            onChangeRaw={blockTypedDateInput}
            showTimeSelect
            timeIntervals={15}
            dateFormat="dd MMM yyyy, HH:mm"
            showIcon
            icon={<span className="material-symbols-outlined text-[16px] leading-none">calendar_month</span>}
            calendarIconClassName="hc-datepicker-icon"
            disabled={loading}
            className="bg-surface-container-low border border-terminal-border rounded-lg text-sm text-on-surface disabled:opacity-50 w-[190px] cursor-pointer"
            wrapperClassName="hc-datepicker-wrapper"
            popperClassName="hc-datepicker-popper"
            calendarClassName="hc-datepicker-calendar"
            portalId={DATEPICKER_PORTAL_ID}
            maxDate={endTime ? new Date(endTime) : undefined}
            autoComplete="off"
          />
        </div>

        <div className="flex flex-col gap-xs">
          <label className="text-[11px] uppercase text-on-surface-variant" htmlFor={`hc-end-${instanceKey}`}>
            End
          </label>
          <DatePicker
            id={`hc-end-${instanceKey}`}
            selected={endTime ? new Date(endTime) : null}
            onChange={(date) => date && dispatch(actions.setEndTime(formatPickerValue(date)))}
            onChangeRaw={blockTypedDateInput}
            showTimeSelect
            timeIntervals={15}
            dateFormat="dd MMM yyyy, HH:mm"
            showIcon
            icon={<span className="material-symbols-outlined text-[16px] leading-none">calendar_month</span>}
            calendarIconClassName="hc-datepicker-icon"
            disabled={loading}
            className="bg-surface-container-low border border-terminal-border rounded-lg text-sm text-on-surface disabled:opacity-50 w-[190px] cursor-pointer"
            wrapperClassName="hc-datepicker-wrapper"
            popperClassName="hc-datepicker-popper"
            calendarClassName="hc-datepicker-calendar"
            portalId={DATEPICKER_PORTAL_ID}
            minDate={startTime ? new Date(startTime) : undefined}
            autoComplete="off"
          />
        </div>

        <button
          type="button"
          onClick={handleFetch}
          disabled={!selectedSymbol || !startTime || !endTime || loading}
          className="px-md py-base rounded-lg text-sm bg-primary text-on-primary disabled:opacity-50 disabled:cursor-default hover:opacity-90 flex items-center gap-xs"
        >
          {loading ? <Spinner /> : <span className="material-symbols-outlined text-[18px] leading-none">search</span>}
          Fetch Data
        </button>

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
      {insightGenError && <div className="text-xs text-error px-xs">{insightGenError}</div>}

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
                  onClick={() => handleGenerateInsight(entry)}
                  disabled={insightGeneratingId === entry.id}
                  className="text-on-surface-variant hover:text-primary disabled:opacity-50 flex items-center"
                  aria-label={`Generate AI insight for ${entry.symbol}`}
                  title="Generate AI insight"
                >
                  {insightGeneratingId === entry.id ? <Spinner /> : <span className="material-symbols-outlined text-[16px] leading-none">psychology</span>}
                </button>
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

      {watchedEntry && automatedInsight && (
        <AiInsightCard insight={automatedInsight} title={`Watchlist Insight · updated ${timeAgo(automatedInsight.createdAt)}`} />
      )}

      {indicatorConfig.rsiDivergence.enabled && (
        <DivergenceCard
          events={indicatorSeries[`RSIDIV:${indicatorConfig.rsiDivergence.rsiPeriod}:${indicatorConfig.rsiDivergence.lookback}`] || []}
        />
      )}

      {indicatorConfig.macdCrossover.enabled && (
        <CrossoverCard
          title="MACD Crossover"
          formatDetail={(v) => `MACD ${v.macd.toFixed(2)} / Signal ${v.signal.toFixed(2)}`}
          events={
            indicatorSeries[
              `MACDCROSS:${indicatorConfig.macdCrossover.fastPeriod}:${indicatorConfig.macdCrossover.slowPeriod}:${indicatorConfig.macdCrossover.signalPeriod}`
            ] || []
          }
        />
      )}

      {indicatorConfig.tsiCrossover.enabled && (
        <CrossoverCard
          title="TSI Crossover"
          formatDetail={(v) => `TSI ${v.tsi.toFixed(2)} / Signal ${v.signal.toFixed(2)}`}
          events={
            indicatorSeries[
              `TSICROSS:${indicatorConfig.tsiCrossover.longPeriod}:${indicatorConfig.tsiCrossover.shortPeriod}:${indicatorConfig.tsiCrossover.signalPeriod}`
            ] || []
          }
        />
      )}

      {indicatorConfig.stochRsiCrossover.enabled && (
        <CrossoverCard
          title="Stoch RSI Crossover"
          formatDetail={(v) => `%K ${v.k.toFixed(2)} / %D ${v.d.toFixed(2)}`}
          events={
            indicatorSeries[
              `STOCHRSICROSS:${indicatorConfig.stochRsiCrossover.rsiPeriod}:${indicatorConfig.stochRsiCrossover.stochasticPeriod}:${indicatorConfig.stochRsiCrossover.kPeriod}:${indicatorConfig.stochRsiCrossover.dPeriod}`
            ] || []
          }
        />
      )}

      {indicatorConfig.adxCrossover.enabled && (
        <CrossoverCard
          title="ADX Crossover"
          formatDetail={(v) => `+DI ${v.pdi.toFixed(2)} / -DI ${v.mdi.toFixed(2)}`}
          events={indicatorSeries[`ADXCROSS:${indicatorConfig.adxCrossover.period}`] || []}
        />
      )}

      {indicatorConfig.smaCrossover.enabled && (
        <CrossoverCard
          title="SMA Crossover"
          formatDetail={(v) => `Fast ${v.fast.toFixed(2)} / Slow ${v.slow.toFixed(2)}`}
          events={indicatorSeries[`SMACROSS:${indicatorConfig.smaCrossover.fastPeriod}:${indicatorConfig.smaCrossover.slowPeriod}`] || []}
        />
      )}

      {indicatorConfig.emaCrossover.enabled && (
        <CrossoverCard
          title="EMA Crossover"
          formatDetail={(v) => `Fast ${v.fast.toFixed(2)} / Slow ${v.slow.toFixed(2)}`}
          events={indicatorSeries[`EMACROSS:${indicatorConfig.emaCrossover.fastPeriod}:${indicatorConfig.emaCrossover.slowPeriod}`] || []}
        />
      )}

      {!selectedSymbol && (
        <div className="glass-panel p-xl rounded-xl text-center text-on-surface-variant text-sm">Search for a symbol above to load its chart.</div>
      )}
      {selectedSymbol && !loading && !error && candles.length === 0 && (
        <div className="glass-panel p-xl rounded-xl text-center text-on-surface-variant text-sm">Click "Fetch Data" to load the chart for the selected filters.</div>
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
        <div
          ref={chartPanelRef}
          className={
            isFullscreen
              ? 'bg-surface p-md flex flex-col gap-sm w-screen h-screen'
              : 'glass-panel p-md rounded-xl flex flex-col gap-sm'
          }
        >
          <div className="flex items-center justify-between gap-sm flex-wrap">
            <span className="text-sm text-on-surface-variant">
              <span className="text-on-surface font-medium">{selectedSymbol}</span> · {exchange} ·{' '}
              {INTERVAL_OPTIONS.find((opt) => opt.value === interval)?.label || interval}
            </span>
            <div className="flex items-center gap-sm">
              <button
                type="button"
                onClick={handleFetch}
                disabled={loading}
                title="Refresh"
                aria-label="Refresh chart"
                className="material-symbols-outlined text-[20px] leading-none text-on-surface-variant hover:text-on-surface disabled:opacity-50 cursor-pointer disabled:cursor-default"
              >
                refresh
              </button>
              <button
                type="button"
                onClick={handleToggleFullscreen}
                disabled={!screenfull.isEnabled}
                title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
                className="material-symbols-outlined text-[20px] leading-none text-on-surface-variant hover:text-on-surface disabled:opacity-50 cursor-pointer disabled:cursor-default"
              >
                {isFullscreen ? 'fullscreen_exit' : 'fullscreen'}
              </button>
            </div>
          </div>
          <div className={isFullscreen ? 'relative flex-1 overflow-auto' : 'relative'}>
            {(loading || indicatorsLoading) && (
              <div className="absolute inset-0 bg-surface/40 rounded-xl flex items-start justify-center pt-xl z-10">
                <div className="glass-panel px-md py-sm rounded-lg flex items-center gap-sm text-sm text-on-surface">
                  <Spinner />
                  {loading ? 'Refreshing chart...' : 'Updating indicators...'}
                </div>
              </div>
            )}
            <HistoricalCandlestickChart
              candles={candles}
              indicatorSeries={indicatorSeries}
              indicatorConfig={indicatorConfig}
              isFullscreen={isFullscreen}
            />
          </div>
        </div>
      )}
    </div>
  )
}

export default HistoricalChartTab
