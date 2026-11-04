/**
 * Crossover Scanner tab - manage the symbol list scanned once per closed
 * 1-hour candle (functions/crossoverScanner.js) and review recent crossover
 * alerts. Alerts also arrive in the header notification bell. State is local
 * to this tab: everything here is server-owned (Firestore) and refetched.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  getCrossoverScannerSymbols,
  addCrossoverScannerSymbol,
  removeCrossoverScannerSymbol,
  runCrossoverScan,
  getCrossoverEvents,
  searchInstruments,
} from '../services/api'
import { formatCandleTime, formatLines, getNotificationPermission, requestNotificationPermission, showBrowserNotification } from './crossoverFormat'
import Spinner from './Spinner'

const POLL_MS = 60 * 1000
const SEARCH_DEBOUNCE_MS = 300

function errorMessage(error) {
  return error?.response?.data?.error || error?.message || 'Something went wrong'
}

function CrossoverScannerTab() {
  const [symbols, setSymbols] = useState([])
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [adding, setAdding] = useState(false)

  const [permission, setPermission] = useState(getNotificationPermission())
  const [scanning, setScanning] = useState(false)
  const [scanSummary, setScanSummary] = useState(null)

  const load = useCallback(async () => {
    try {
      // Independent: a failing events query (e.g. its Firestore index not
      // deployed yet) must not hide the symbol list.
      const [symbolsResult, eventsResult] = await Promise.allSettled([getCrossoverScannerSymbols(), getCrossoverEvents(50)])
      if (symbolsResult.status === 'rejected') throw symbolsResult.reason
      setSymbols(symbolsResult.value.symbols || [])
      if (eventsResult.status === 'fulfilled') {
        setEvents(eventsResult.value.events || [])
        setError('')
      } else {
        setError(`Could not load recent crossovers: ${errorMessage(eventsResult.reason)}`)
      }
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, POLL_MS)
    return () => clearInterval(id)
  }, [load])

  // Debounced instrument search - same /instrument-search the Chart tab uses.
  useEffect(() => {
    const needle = query.trim()
    if (needle.length < 2) {
      setResults([])
      return undefined
    }
    let cancelled = false
    const id = setTimeout(() => {
      searchInstruments(needle)
        .then(({ results: found }) => {
          if (!cancelled) setResults((found || []).slice(0, 8))
        })
        .catch(() => {
          if (!cancelled) setResults([])
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(id)
    }
  }, [query])

  const handleAdd = async (instrument) => {
    setAdding(true)
    setError('')
    try {
      await addCrossoverScannerSymbol({ symbol: instrument.symbol, exchange: instrument.exchange })
      setQuery('')
      setResults([])
      await load()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setAdding(false)
    }
  }

  const handleRemove = async (id) => {
    setError('')
    try {
      await removeCrossoverScannerSymbol(id)
      setSymbols((current) => current.filter((s) => s.id !== id))
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const handleEnableDesktopAlerts = async () => {
    const result = await requestNotificationPermission()
    setPermission(result)
    if (result === 'granted') {
      showBrowserNotification({ title: 'Desktop alerts enabled', body: 'You will be notified of new crossovers while this tab is in the background.', tag: 'crossover-test' })
    }
  }

  const handleScanNow = async () => {
    setScanning(true)
    setScanSummary(null)
    setError('')
    try {
      setScanSummary(await runCrossoverScan())
      await load()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setScanning(false)
    }
  }

  return (
    <div className="flex flex-col gap-lg">
      <div className="flex items-center justify-between gap-md flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-on-surface">Crossover Scanner</h2>
          <p className="text-xs text-on-surface-variant">
            1-hour candles · MACD, TSI, Stoch RSI, ADX, SMA 50/200, EMA 12/26 · scanned after each bar closes (10:00–15:30 IST, Mon–Fri)
          </p>
        </div>
        <div className="flex items-center gap-md">
          {permission === 'default' && (
            <button type="button" onClick={handleEnableDesktopAlerts} className="text-sm text-primary hover:underline">
              Enable desktop alerts
            </button>
          )}
          {permission === 'granted' && <span className="text-xs text-on-surface-variant">Desktop alerts on</span>}
          {permission === 'denied' && <span className="text-xs text-on-surface-variant">Desktop alerts blocked in browser settings</span>}
          <button
            type="button"
            onClick={handleScanNow}
            disabled={scanning}
            className="px-md py-sm rounded-lg bg-primary-container text-on-primary-container text-sm font-medium disabled:opacity-50 flex items-center gap-sm"
          >
            {scanning && <Spinner />}
            Scan now
          </button>
        </div>
      </div>

      {error && <div className="text-sm text-bearish">{error}</div>}
      {scanSummary && (
        <div className="text-sm text-on-surface-variant">
          Scanned {scanSummary.scanned} symbol{scanSummary.scanned === 1 ? '' : 's'} · {scanSummary.newAlerts} new alert{scanSummary.newAlerts === 1 ? '' : 's'}
          {scanSummary.errors?.length > 0 && <span className="text-bearish"> · {scanSummary.errors.length} failed ({scanSummary.errors.map((e) => e.symbol).join(', ')})</span>}
        </div>
      )}

      <section className="glass-panel rounded-xl p-md flex flex-col gap-md">
        <div className="flex flex-col gap-xs relative max-w-md">
          <label className="text-xs font-medium uppercase text-on-surface-variant" htmlFor="scanner-symbol-search">
            Add symbol
          </label>
          <input
            id="scanner-symbol-search"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by symbol or company name…"
            disabled={adding}
            className="bg-surface-container-low border border-terminal-border rounded-lg text-sm px-md py-base text-on-surface"
          />
          {results.length > 0 && (
            <ul className="absolute top-full mt-1 w-full bg-surface-container-low border border-terminal-border rounded-lg z-10 max-h-64 overflow-y-auto">
              {results.map((r) => {
                const already = symbols.some((s) => s.symbol === r.symbol && s.exchange === r.exchange)
                return (
                  <li key={`${r.exchange}-${r.symbol}`}>
                    <button
                      type="button"
                      disabled={already}
                      onClick={() => handleAdd(r)}
                      className="w-full text-left px-md py-sm text-sm hover:bg-surface-container-highest disabled:opacity-50 disabled:cursor-default"
                    >
                      <span className="font-medium text-on-surface">{r.symbol}</span>
                      <span className="text-on-surface-variant"> · {r.name} · {r.exchange}</span>
                      {already && <span className="text-on-surface-variant"> (already added)</span>}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {loading ? (
          <Spinner />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-on-surface-variant">
                <th className="py-xs">Symbol</th>
                <th className="py-xs">Last scanned</th>
                <th className="py-xs">Status</th>
                <th className="py-xs" />
              </tr>
            </thead>
            <tbody>
              {symbols.map((s) => (
                <tr key={s.id} className="border-t border-outline-variant">
                  <td className="py-xs font-medium text-on-surface">
                    {s.symbol} <span className="text-xs text-on-surface-variant">{s.exchange}</span>
                  </td>
                  <td className="py-xs text-on-surface-variant">{s.lastScanAt ? new Date(s.lastScanAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }) : 'Not yet'}</td>
                  <td className="py-xs">{s.lastError ? <span className="text-bearish" title={s.lastError.message}>Error: {s.lastError.message}</span> : <span className="text-on-surface-variant">OK</span>}</td>
                  <td className="py-xs text-right">
                    <button type="button" onClick={() => handleRemove(s.id)} className="text-xs text-on-surface-variant hover:text-bearish">
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
              {symbols.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-md text-center text-on-surface-variant">
                    No symbols yet - search above to add one.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </section>

      <section className="glass-panel rounded-xl p-md flex flex-col gap-sm">
        <h3 className="text-sm font-semibold text-on-surface">Recent crossovers</h3>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase text-on-surface-variant">
              <th className="py-xs">Bar (IST)</th>
              <th className="py-xs">Symbol</th>
              <th className="py-xs">Indicator</th>
              <th className="py-xs">Signal</th>
              <th className="py-xs">Close</th>
              <th className="py-xs">Lines</th>
              <th className="py-xs">Also crossed</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id} className="border-t border-outline-variant">
                <td className="py-xs text-on-surface-variant whitespace-nowrap">{formatCandleTime(e.candleTimestamp)}</td>
                <td className="py-xs font-medium text-on-surface">{e.symbol}</td>
                <td className="py-xs text-on-surface">{e.indicatorLabel}</td>
                <td className={`py-xs font-semibold ${e.direction === 'bullish' ? 'text-bullish' : 'text-bearish'}`}>{e.direction === 'bullish' ? '▲ Bullish' : '▼ Bearish'}</td>
                <td className="py-xs text-on-surface">₹{e.closePrice}</td>
                <td className="py-xs text-on-surface-variant">{formatLines(e.lines)}</td>
                <td className="py-xs text-on-surface-variant">{e.confluence?.length ? e.confluence.join(', ') : '—'}</td>
              </tr>
            ))}
            {events.length === 0 && (
              <tr>
                <td colSpan={7} className="py-md text-center text-on-surface-variant">
                  No crossovers detected yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  )
}

export default CrossoverScannerTab
