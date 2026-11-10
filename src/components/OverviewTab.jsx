/**
 * Overview page - one row per scanner symbol, one column per timeframe, so the
 * crossover data for every symbol is visible at a glance. Data comes from the
 * summary the scanner writes on every scan (the most recent crossover per
 * indicator), so it shows everything - including crossovers that were below
 * the alert threshold and never raised a notification.
 *
 * A cell is the net bias over the last RECENT_BARS closed bars: how many
 * indicators crossed bullish vs bearish. Click a row to see every indicator's
 * latest crossover on every timeframe. Stocks are managed on the Crossover
 * Scanner page; nothing is entered here.
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { getCrossoverOverview } from '../services/api'
import { TIMEFRAME_ORDER, TIMEFRAME_LABELS, formatCrossoverTime, formatLines, timeAgo } from './crossoverFormat'
import Spinner from './Spinner'

const POLL_MS = 120 * 1000
const RECENT_BARS = 3

const INDEX_PATTERN = /^(NIFTY|BANKNIFTY|FINNIFTY|MIDCPNIFTY|MIDCAP|SENSEX|BANKEX)/

const isIndexSymbol = (symbol) => INDEX_PATTERN.test(symbol)
// The server flags indices (instrument type IDX); the pattern is the fallback.
const isIndexEntry = (entry) => entry.isIndex ?? isIndexSymbol(entry.symbol)
const ADX_STATUS = { increase: 'Increased', decrease: 'Decreased', flat: 'Flat' }

// What one symbol looks like on one timeframe.
function cellInfo(entry, interval) {
  const state = entry.intervals?.[interval]
  if (!state) return { status: 'pending', bull: 0, bear: 0, agreement: 0, bias: 'none', latestTs: 0 }
  if (!state.summary) {
    return { status: state.lastError ? 'error' : 'pending', error: state.lastError?.message, bull: 0, bear: 0, agreement: 0, bias: 'none', latestTs: 0 }
  }
  const recent = state.summary.signals.filter((signal) => signal.barsAgo < RECENT_BARS)
  const bull = recent.filter((signal) => signal.direction === 'bullish').length
  const bear = recent.length - bull
  let bias = 'none'
  if (bull > bear) bias = 'bullish'
  else if (bear > bull) bias = 'bearish'
  else if (bull > 0) bias = 'mixed'
  return {
    status: 'ok',
    bull,
    bear,
    agreement: Math.max(bull, bear),
    bias,
    latestTs: recent.reduce((max, signal) => Math.max(max, signal.ts), 0),
    summary: state.summary,
    lastBarEnd: state.lastBarEnd,
  }
}

function Cell({ info }) {
  if (info.status === 'pending') return <span className="text-on-surface-variant opacity-60">Pending</span>
  if (info.status === 'error') {
    return (
      <span className="text-bearish" title={info.error}>
        Error
      </span>
    )
  }
  if (info.bias === 'none') return <span className="text-on-surface-variant opacity-60">—</span>
  return (
    <span className="font-semibold">
      {info.bull > 0 && <span className="text-bullish">▲ {info.bull}</span>}
      {info.bull > 0 && info.bear > 0 && ' '}
      {info.bear > 0 && <span className="text-bearish">▼ {info.bear}</span>}
    </span>
  )
}

function ExpandedRow({ entry, colSpan }) {
  return (
    <tr className="bg-surface-container-low">
      <td colSpan={colSpan} className="p-md">
        <div className="grid gap-md grid-cols-1 lg:grid-cols-2 xl:grid-cols-3">
          {TIMEFRAME_ORDER.map((interval) => {
            const info = cellInfo(entry, interval)
            const signals = [...(info.summary?.signals || [])].sort((a, b) => b.ts - a.ts)
            return (
              <div key={interval} className="rounded-lg border border-outline-variant p-sm">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-on-surface">{TIMEFRAME_LABELS[interval]}</span>
                  {info.summary && <span className="text-[11px] text-on-surface-variant">Close ₹{info.summary.lastClose}</span>}
                </div>
                {info.status !== 'ok' && <div className="text-xs text-on-surface-variant pt-xs">{info.status === 'error' ? info.error : 'Pending first scan'}</div>}
                {info.summary?.adx && (
                  <div className="text-xs text-on-surface-variant pt-xs">
                    ADX ({info.summary.adx.period || 14}): current <span className="font-mono text-on-surface">{info.summary.adx.value.toFixed(2)}</span> · previous{' '}
                    <span className="font-mono text-on-surface">{info.summary.adx.prev.toFixed(2)}</span> · {ADX_STATUS[info.summary.adx.trend]}
                  </div>
                )}
                {info.status === 'ok' && signals.length === 0 && <div className="text-xs text-on-surface-variant pt-xs">No crossover in the loaded history.</div>}
                <ul className="flex flex-col gap-xs pt-xs">
                  {signals.map((signal) => (
                    <li key={signal.label} className="text-xs text-on-surface-variant">
                      <span className={signal.direction === 'bullish' ? 'text-bullish font-semibold' : 'text-bearish font-semibold'}>{signal.direction === 'bullish' ? '▲' : '▼'}</span>{' '}
                      <span className="text-on-surface">{signal.label}</span> · {signal.barsAgo === 0 ? 'latest bar' : `${signal.barsAgo} bar${signal.barsAgo === 1 ? '' : 's'} ago`} · {formatCrossoverTime({ candleTimestamp: signal.ts, interval })}
                      <div>
                        Close ₹{signal.close} · {formatLines(signal.lines)}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
        </div>
      </td>
    </tr>
  )
}

const selectClass = 'bg-surface-container-low border border-terminal-border rounded-lg text-sm px-md py-xs text-on-surface'

function OverviewTab() {
  const [symbols, setSymbols] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [fetchedAt, setFetchedAt] = useState(null)

  const [query, setQuery] = useState('')
  const [group, setGroup] = useState('all')
  const [bias, setBias] = useState('any')
  const [minAgree, setMinAgree] = useState(0)
  const [focus, setFocus] = useState('all')
  const [sortBy, setSortBy] = useState('list')
  const [expanded, setExpanded] = useState(() => new Set())

  const load = useCallback(async () => {
    try {
      const { symbols: fetched } = await getCrossoverOverview()
      setSymbols(fetched || [])
      setFetchedAt(new Date().toISOString())
      setError('')
    } catch (err) {
      setError(err?.response?.data?.error || err?.message || 'Failed to load the overview')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, POLL_MS)
    return () => clearInterval(id)
  }, [load])

  const focusIntervals = useMemo(() => (focus === 'all' ? TIMEFRAME_ORDER : [focus]), [focus])

  // Every symbol's cell on every timeframe, computed once per data refresh.
  const rows = useMemo(() => symbols.map((entry) => ({ entry, cells: Object.fromEntries(TIMEFRAME_ORDER.map((interval) => [interval, cellInfo(entry, interval)])) })), [symbols])

  // Header strip: per timeframe, how many symbols lean each way.
  const timeframeCounts = useMemo(
    () =>
      Object.fromEntries(
        TIMEFRAME_ORDER.map((interval) => [
          interval,
          {
            bullish: rows.filter((r) => r.cells[interval].bias === 'bullish').length,
            bearish: rows.filter((r) => r.cells[interval].bias === 'bearish').length,
          },
        ])
      ),
    [rows]
  )

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const filtered = rows.filter(({ entry, cells }) => {
      if (needle && !entry.symbol.toLowerCase().includes(needle)) return false
      if (group === 'stocks' && isIndexEntry(entry)) return false
      if (group === 'indices' && !isIndexEntry(entry)) return false
      if (bias === 'any' && minAgree === 0) return true
      // Passes if ANY focused timeframe satisfies both the bias and the minimum agreement.
      return focusIntervals.some((interval) => {
        const info = cells[interval]
        if (info.status !== 'ok') return false
        if (bias !== 'any' && info.bias !== bias) return false
        return info.agreement >= minAgree
      })
    })

    const bestAgreement = (cells) => Math.max(...focusIntervals.map((interval) => cells[interval].agreement))
    const latest = (cells) => Math.max(...focusIntervals.map((interval) => cells[interval].latestTs))
    return [...filtered].sort((a, b) => {
      if (sortBy === 'agreement') return bestAgreement(b.cells) - bestAgreement(a.cells) || a.entry.symbol.localeCompare(b.entry.symbol)
      if (sortBy === 'recent') return latest(b.cells) - latest(a.cells) || a.entry.symbol.localeCompare(b.entry.symbol)
      if (sortBy === 'symbol') return a.entry.symbol.localeCompare(b.entry.symbol)
      // List order: indices first, then the uploaded list order (server sends it pre-sorted this way).
      return (isIndexEntry(a.entry) ? 0 : 1) - (isIndexEntry(b.entry) ? 0 : 1) || (a.entry.sortOrder ?? 1e6) - (b.entry.sortOrder ?? 1e6) || a.entry.symbol.localeCompare(b.entry.symbol)
    })
  }, [rows, query, group, bias, minAgree, focusIntervals, sortBy])

  const toggleRow = (id) =>
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const colSpan = TIMEFRAME_ORDER.length + 3
  const scanned = rows.filter((r) => TIMEFRAME_ORDER.some((interval) => r.cells[interval].status === 'ok')).length

  return (
    <div className="flex flex-col gap-lg">
      <div className="flex items-center justify-between gap-md flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-on-surface">Overview</h2>
          <p className="text-xs text-on-surface-variant">
            {symbols.length} symbols · {scanned} scanned · bias = indicators that crossed in the last {RECENT_BARS} closed bars
            {fetchedAt ? ` · updated ${timeAgo(fetchedAt)}` : ''}
          </p>
        </div>
      </div>

      <div className="grid gap-sm grid-cols-2 md:grid-cols-5">
        {TIMEFRAME_ORDER.map((interval) => (
          <div key={interval} className="glass-panel rounded-lg p-sm">
            <div className="text-xs text-on-surface-variant">{TIMEFRAME_LABELS[interval]}</div>
            <div className="text-sm font-semibold">
              <span className="text-bullish">▲ {timeframeCounts[interval].bullish}</span> <span className="text-bearish">▼ {timeframeCounts[interval].bearish}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-sm flex-wrap">
        <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search symbol…" className={`${selectClass} min-w-[180px]`} aria-label="Search symbol" />
        <select value={group} onChange={(e) => setGroup(e.target.value)} className={selectClass} aria-label="Group">
          <option value="all">Stocks and indices</option>
          <option value="stocks">Stocks only</option>
          <option value="indices">Indices only</option>
        </select>
        <select value={focus} onChange={(e) => setFocus(e.target.value)} className={selectClass} aria-label="Timeframe for filter and sort">
          <option value="all">Any timeframe</option>
          {TIMEFRAME_ORDER.map((interval) => (
            <option key={interval} value={interval}>
              {TIMEFRAME_LABELS[interval]}
            </option>
          ))}
        </select>
        <select value={bias} onChange={(e) => setBias(e.target.value)} className={selectClass} aria-label="Bias">
          <option value="any">Any bias</option>
          <option value="bullish">Bullish</option>
          <option value="bearish">Bearish</option>
        </select>
        <select value={minAgree} onChange={(e) => setMinAgree(Number(e.target.value))} className={selectClass} aria-label="Minimum agreeing indicators">
          <option value={0}>Any agreement</option>
          {[1, 2, 3, 4, 5, 6, 7].map((n) => (
            <option key={n} value={n}>
              {n}+ indicators agree
            </option>
          ))}
        </select>
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} className={selectClass} aria-label="Sort">
          <option value="list">Sort: list order (indices first)</option>
          <option value="symbol">Sort: symbol A–Z</option>
          <option value="agreement">Sort: most agreement</option>
          <option value="recent">Sort: most recent</option>
        </select>
        <span className="text-xs text-on-surface-variant">{visible.length} shown</span>
      </div>

      {error && <div className="text-sm text-bearish">{error}</div>}
      {loading && <Spinner />}

      {!loading && (
        <div className="glass-panel rounded-xl overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-on-surface-variant">
                <th className="p-sm w-6" />
                <th className="p-sm">Symbol</th>
                <th className="p-sm">Close</th>
                {TIMEFRAME_ORDER.map((interval) => (
                  <th key={interval} className="p-sm whitespace-nowrap">
                    {TIMEFRAME_LABELS[interval]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map(({ entry, cells }) => {
                const isOpen = expanded.has(entry.id)
                const close = cells['1day'].summary?.lastClose ?? TIMEFRAME_ORDER.map((i) => cells[i].summary?.lastClose).find((v) => v != null)
                return (
                  <Fragment key={entry.id}>
                    <tr className="border-t border-outline-variant hover:bg-surface-container-highest cursor-pointer" onClick={() => toggleRow(entry.id)}>
                      <td className="p-sm">
                        <span className="material-symbols-outlined text-on-surface-variant text-base">{isOpen ? 'expand_more' : 'chevron_right'}</span>
                      </td>
                      <td className="p-sm font-medium text-on-surface whitespace-nowrap">
                        {entry.symbol} <span className="text-xs text-on-surface-variant">{isIndexEntry(entry) ? 'Index' : entry.exchange}</span>
                      </td>
                      <td className="p-sm text-on-surface-variant whitespace-nowrap">{close != null ? `₹${close}` : '—'}</td>
                      {TIMEFRAME_ORDER.map((interval) => (
                        <td key={interval} className="p-sm whitespace-nowrap">
                          <Cell info={cells[interval]} />
                        </td>
                      ))}
                    </tr>
                    {isOpen && <ExpandedRow entry={entry} colSpan={colSpan} />}
                  </Fragment>
                )
              })}
              {visible.length === 0 && (
                <tr>
                  <td colSpan={colSpan} className="p-lg text-center text-on-surface-variant">
                    {symbols.length === 0 ? 'No symbols yet - add some on the Crossover Scanner page.' : 'No symbols match these filters.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export default OverviewTab
