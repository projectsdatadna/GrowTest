/**
 * Crossover Scanner page - the ONE stock list, the automatic-scan status and
 * the timeframe settings. The scanner runs by itself (a scheduled dispatcher
 * in functions/index.js ticks every 15 minutes and scans whatever bar has
 * just closed on each enabled timeframe), so there is no "Scan now" here, and
 * alerts are read on the Notifications page rather than listed twice.
 * State is local: everything is server-owned (Firestore) and refetched.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  getCrossoverScannerSymbols,
  addCrossoverScannerSymbol,
  removeCrossoverScannerSymbol,
  bulkAddCrossoverScannerSymbols,
  getCrossoverSettings,
  saveCrossoverSettings,
  getCrossoverStatus,
  searchInstruments,
} from '../services/api'
import {
  formatCandleTime,
  getNotificationPermission,
  requestNotificationPermission,
  showBrowserNotification,
  timeAgo,
  TIMEFRAME_ORDER,
  TIMEFRAME_LABELS,
} from './crossoverFormat'
import Spinner from './Spinner'

const POLL_MS = 60 * 1000
const SEARCH_DEBOUNCE_MS = 300

function errorMessage(error) {
  return error?.response?.data?.error || error?.message || 'Something went wrong'
}

// One symbol's state on one timeframe: last bar processed, error, or pending.
function TimeframeStateCell({ state }) {
  if (state?.lastError) {
    return (
      <span className="text-bearish" title={state.lastError.message}>
        Error
      </span>
    )
  }
  if (state?.lastBarEnd) return <span className="text-on-surface-variant">{formatCandleTime(state.lastBarEnd)}</span>
  return <span className="text-on-surface-variant opacity-60">Pending</span>
}

function TokenBanner({ token }) {
  if (token?.ok === false) {
    return (
      <div className="text-sm text-bearish">
        Groww token problem: {token.message}. Automatic scans are paused until a fresh token is pasted in the Greek Analysis tab.
      </div>
    )
  }
  if (token?.ok === true) return <div className="text-xs text-on-surface-variant">Groww token OK · checked {timeAgo(token.at)}</div>
  return <div className="text-xs text-on-surface-variant">Waiting for the first automatic scan…</div>
}

function BulkResultSummary({ results }) {
  const added = results.filter((r) => r.status === 'added').length
  const existing = results.filter((r) => r.status === 'exists').length
  const failed = results.filter((r) => r.status === 'invalid' || r.status === 'not-found')
  return (
    <div className="text-sm text-on-surface-variant">
      {added} added · {existing} already in the list
      {failed.length > 0 && (
        <span className="text-bearish">
          {' '}
          · {failed.length} failed: {failed.map((r) => r.symbol).join(', ')}
        </span>
      )}
    </div>
  )
}

function CrossoverScannerTab({ onTabChange }) {
  const [symbols, setSymbols] = useState([])
  const [status, setStatus] = useState(null)
  const [settings, setSettings] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [adding, setAdding] = useState(false)

  const [bulkText, setBulkText] = useState('')
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkResults, setBulkResults] = useState(null)

  const [filter, setFilter] = useState('')
  const [permission, setPermission] = useState(getNotificationPermission())

  const load = useCallback(async () => {
    // Independent: a failing status/settings read must not hide the symbol list.
    const [symbolsResult, statusResult, settingsResult] = await Promise.allSettled([getCrossoverScannerSymbols(), getCrossoverStatus(), getCrossoverSettings()])
    if (symbolsResult.status === 'fulfilled') setSymbols(symbolsResult.value.symbols || [])
    if (statusResult.status === 'fulfilled') setStatus(statusResult.value)
    if (settingsResult.status === 'fulfilled') setSettings(settingsResult.value.settings)
    const failed = [symbolsResult, statusResult, settingsResult].find((r) => r.status === 'rejected')
    setError(failed ? errorMessage(failed.reason) : '')
    setLoading(false)
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

  const handleBulkAdd = async () => {
    setBulkBusy(true)
    setBulkResults(null)
    setError('')
    try {
      const { results: outcome } = await bulkAddCrossoverScannerSymbols(bulkText)
      setBulkResults(outcome)
      // Keep only what failed in the box so it can be corrected and retried.
      setBulkText(outcome.filter((r) => r.status === 'invalid' || r.status === 'not-found').map((r) => r.symbol).join(', '))
      await load()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBulkBusy(false)
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

  // kind: 'enabledIntervals' (scan this timeframe) or 'popupIntervals'
  // (pop up for this timeframe). Optimistic; reloads on failure.
  const toggleSetting = async (kind, interval) => {
    if (!settings) return
    const current = new Set(settings[kind])
    if (current.has(interval)) current.delete(interval)
    else current.add(interval)
    const next = TIMEFRAME_ORDER.filter((i) => current.has(i))
    setSettings({ ...settings, [kind]: next })
    try {
      const { settings: saved } = await saveCrossoverSettings({ [kind]: next })
      setSettings(saved)
      load()
    } catch (err) {
      setError(errorMessage(err))
      load()
    }
  }

  // Minimum number of agreeing indicators before a crossover on this timeframe
  // raises a popup/bell alert (every crossover still shows on the Overview).
  const setMinAgreement = async (interval, value) => {
    if (!settings) return
    setSettings({ ...settings, minAgreement: { ...settings.minAgreement, [interval]: value } })
    try {
      const { settings: saved } = await saveCrossoverSettings({ minAgreement: { [interval]: value } })
      setSettings(saved)
    } catch (err) {
      setError(errorMessage(err))
      load()
    }
  }

  const handleEnableDesktopAlerts = async () => {
    const result = await requestNotificationPermission()
    setPermission(result)
    if (result === 'granted') {
      showBrowserNotification({ title: 'Desktop alerts enabled', body: 'You will be notified of new crossovers while this tab is in the background.', tag: 'crossover-test' })
    }
  }

  const needle = filter.trim().toLowerCase()
  const shownSymbols = needle ? symbols.filter((s) => s.symbol.toLowerCase().includes(needle)) : symbols
  const visibleTimeframes = TIMEFRAME_ORDER.filter((i) => !settings || settings.enabledIntervals.includes(i))

  return (
    <div className="flex flex-col gap-lg">
      <div className="flex items-center justify-between gap-md flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-on-surface">Crossover Scanner</h2>
          <p className="text-xs text-on-surface-variant">
            Runs automatically after every bar close · MACD, TSI, Stoch RSI, ADX, SMA 50/200, EMA 12/26 · one stock list for every timeframe
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
          {onTabChange && (
            <button type="button" onClick={() => onTabChange('notifications')} className="px-md py-sm rounded-lg bg-primary-container text-on-primary-container text-sm font-medium">
              View alerts →
            </button>
          )}
        </div>
      </div>

      {error && <div className="text-sm text-bearish">{error}</div>}

      <section className="glass-panel rounded-xl p-md flex flex-col gap-md">
        <div className="flex items-center justify-between gap-md flex-wrap">
          <h3 className="text-sm font-semibold text-on-surface">Schedule</h3>
          <TokenBanner token={status?.token} />
        </div>
        <div className="grid gap-sm grid-cols-1 md:grid-cols-3 xl:grid-cols-5">
          {TIMEFRAME_ORDER.map((interval) => {
            const info = status?.intervals?.find((i) => i.interval === interval)
            const enabled = settings ? settings.enabledIntervals.includes(interval) : true
            const popup = settings ? settings.popupIntervals.includes(interval) : false
            return (
              <div key={interval} className={`rounded-lg bg-surface-container-low border border-outline-variant p-sm flex flex-col gap-xs ${enabled ? '' : 'opacity-60'}`}>
                <span className="text-sm font-semibold text-on-surface">{TIMEFRAME_LABELS[interval]}</span>
                <label className="flex items-center gap-xs text-xs text-on-surface-variant">
                  <input type="checkbox" checked={enabled} disabled={!settings} onChange={() => toggleSetting('enabledIntervals', interval)} />
                  Scan automatically
                </label>
                <label className="flex items-center gap-xs text-xs text-on-surface-variant">
                  <input type="checkbox" checked={popup} disabled={!settings || !enabled} onChange={() => toggleSetting('popupIntervals', interval)} />
                  Show popup
                </label>
                <label className="flex items-center gap-xs text-xs text-on-surface-variant">
                  Alert when
                  <select
                    value={settings?.minAgreement?.[interval] ?? 1}
                    disabled={!settings || !enabled}
                    onChange={(e) => setMinAgreement(interval, Number(e.target.value))}
                    className="bg-surface-container-low border border-terminal-border rounded text-xs px-xs py-[1px] text-on-surface"
                    aria-label={`Minimum agreeing indicators for ${TIMEFRAME_LABELS[interval]} alerts`}
                  >
                    {[1, 2, 3, 4, 5, 6].map((n) => (
                      <option key={n} value={n}>
                        {n}+
                      </option>
                    ))}
                  </select>
                  indicators agree
                </label>
                <div className="text-[11px] text-on-surface-variant">
                  {info?.expectedBarEnd ? <>Latest bar close: {formatCandleTime(info.expectedBarEnd)} IST</> : 'No bar yet'}
                  <br />
                  {enabled && info ? `${info.dueSymbols} of ${status.symbolCount} symbols pending` : ''}
                  {info?.lastRun && (
                    <>
                      <br />
                      Last run {timeAgo(info.lastRun.lastRunAt)} · {info.lastRun.newAlerts} new alert{info.lastRun.newAlerts === 1 ? '' : 's'}
                      {info.lastRun.errors > 0 && <span className="text-bearish"> · {info.lastRun.errors} errors</span>}
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </section>

      <section className="glass-panel rounded-xl p-md flex flex-col gap-md">
        <h3 className="text-sm font-semibold text-on-surface">Stocks ({symbols.length})</h3>

        <div className="flex flex-col gap-xs relative max-w-md">
          <label className="text-xs font-medium uppercase text-on-surface-variant" htmlFor="scanner-symbol-search">
            Add one symbol
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
                      <span className="text-on-surface-variant">
                        {' '}
                        · {r.name} · {r.exchange}
                      </span>
                      {already && <span className="text-on-surface-variant"> (already added)</span>}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <div className="flex flex-col gap-xs max-w-md">
          <label className="text-xs font-medium uppercase text-on-surface-variant" htmlFor="scanner-bulk-add">
            Or paste many (comma, space or new line separated)
          </label>
          <textarea
            id="scanner-bulk-add"
            rows={3}
            value={bulkText}
            onChange={(e) => setBulkText(e.target.value)}
            placeholder="TCS, INFY, HDFCBANK"
            disabled={bulkBusy}
            className="bg-surface-container-low border border-terminal-border rounded-lg text-sm px-md py-base text-on-surface"
          />
          <div className="flex items-center gap-md">
            <button
              type="button"
              onClick={handleBulkAdd}
              disabled={bulkBusy || bulkText.trim() === ''}
              className="px-md py-sm rounded-lg bg-primary-container text-on-primary-container text-sm font-medium disabled:opacity-50 flex items-center gap-sm"
            >
              {bulkBusy && <Spinner />}
              Add symbols
            </button>
            {bulkResults && <BulkResultSummary results={bulkResults} />}
          </div>
        </div>

        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={`Filter the ${symbols.length} symbols…`}
          className="bg-surface-container-low border border-terminal-border rounded-lg text-sm px-md py-xs text-on-surface max-w-xs"
          aria-label="Filter symbols"
        />

        {loading ? (
          <Spinner />
        ) : (
          <div className="overflow-x-auto max-h-[60vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-on-surface-variant">
                  <th className="py-xs">Symbol</th>
                  {visibleTimeframes.map((interval) => (
                    <th key={interval} className="py-xs pr-md whitespace-nowrap">
                      {TIMEFRAME_LABELS[interval]} · last bar
                    </th>
                  ))}
                  <th className="py-xs" />
                </tr>
              </thead>
              <tbody>
                {shownSymbols.map((s) => (
                  <tr key={s.id} className="border-t border-outline-variant">
                    <td className="py-xs font-medium text-on-surface whitespace-nowrap">
                      {s.symbol} <span className="text-xs text-on-surface-variant">{s.exchange}</span>
                    </td>
                    {visibleTimeframes.map((interval) => (
                      <td key={interval} className="py-xs pr-md text-xs whitespace-nowrap">
                        <TimeframeStateCell state={s.scanState?.[interval]} />
                      </td>
                    ))}
                    <td className="py-xs text-right">
                      <button type="button" onClick={() => handleRemove(s.id)} className="text-xs text-on-surface-variant hover:text-bearish">
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
                {shownSymbols.length === 0 && (
                  <tr>
                    <td colSpan={visibleTimeframes.length + 2} className="py-md text-center text-on-surface-variant">
                      {symbols.length === 0 ? 'No symbols yet - search above or paste a list to add some.' : 'No symbols match the filter.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

export default CrossoverScannerTab
