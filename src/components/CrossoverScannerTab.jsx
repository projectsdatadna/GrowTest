/**
 * Crossover Scanner page - the ONE stock list, the automatic-scan status and
 * the timeframe settings. The scanner runs by itself (a scheduled dispatcher
 * in functions/index.js ticks every 15 minutes and scans whatever bar has
 * just closed on each enabled timeframe). "Run now" scans immediately, for
 * testing without waiting for the next tick. Alerts are read on the
 * Notifications page rather than listed twice. The stock list is shown in its
 * display order (indices first, then the order set by a pasted list with "Use
 * this list as the display order").
 * State is local: everything is server-owned (Firestore) and refetched.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getCrossoverScannerSymbols,
  addCrossoverScannerSymbol,
  removeCrossoverScannerSymbol,
  bulkAddCrossoverScannerSymbols,
  saveCrossoverSymbolOrder,
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
import RunScanButton from './RunScanButton'

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
  const [bulkSetOrder, setBulkSetOrder] = useState(false)
  const [runNotice, setRunNotice] = useState('')

  const [filter, setFilter] = useState('')
  const [dirty, setDirty] = useState(false)
  const [savingOrder, setSavingOrder] = useState(false)
  const [dragId, setDragId] = useState(null)
  const [overId, setOverId] = useState(null)
  const dirtyRef = useRef(false)
  const [permission, setPermission] = useState(getNotificationPermission())

  const load = useCallback(async () => {
    // Independent: a failing status/settings read must not hide the symbol list.
    const [symbolsResult, statusResult, settingsResult] = await Promise.allSettled([getCrossoverScannerSymbols(), getCrossoverStatus(), getCrossoverSettings()])
    // Unsaved drag-and-drop order must survive the background poll.
    if (symbolsResult.status === 'fulfilled' && !dirtyRef.current) setSymbols(symbolsResult.value.symbols || [])
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
      const { results: outcome, order } = await bulkAddCrossoverScannerSymbols(bulkText, { setOrder: bulkSetOrder })
      setBulkResults(outcome)
      if (order) setRunNotice(`Display order saved for ${order.ordered} symbols${order.unlisted?.length ? `; ${order.unlisted.length} not in the list go last` : ''}.`)
      // Keep only what failed in the box so it can be corrected and retried.
      setBulkText(outcome.filter((r) => r.status === 'invalid' || r.status === 'not-found').map((r) => r.symbol).join(', '))
      await load()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBulkBusy(false)
    }
  }

  const setDirtyFlag = (value) => {
    dirtyRef.current = value
    setDirty(value)
  }

  // Drop: move the dragged row to the target's position (same group only -
  // indices are always pinned above stocks).
  const handleDrop = (targetId) => {
    const sourceId = dragId
    setDragId(null)
    setOverId(null)
    if (!sourceId || sourceId === targetId) return
    const from = symbols.findIndex((s) => s.id === sourceId)
    const to = symbols.findIndex((s) => s.id === targetId)
    if (from < 0 || to < 0 || Boolean(symbols[from].isIndex) !== Boolean(symbols[to].isIndex)) return
    const next = [...symbols]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    setSymbols(next)
    setDirtyFlag(true)
  }

  const handleSaveOrder = async () => {
    setSavingOrder(true)
    setError('')
    try {
      const result = await saveCrossoverSymbolOrder(symbols.map((s) => s.symbol))
      setDirtyFlag(false)
      setRunNotice(`Priority order saved for ${result.ordered} symbols - notifications, overview and export now follow it.`)
      await load()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSavingOrder(false)
    }
  }

  const handleDiscardOrder = async () => {
    setDirtyFlag(false)
    await load()
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

  // kind: 'enabledIntervals' (scan this timeframe). Optimistic; reloads on failure.
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
            Runs automatically after every bar close · MACD, TSI, Stoch RSI, DMI (+DI/-DI), RSI 14/14, SMA 50/200, EMA 12/26 crossovers + ADX trend · one stock list for every timeframe
          </p>
        </div>
        <div className="flex items-center gap-md">
          {permission === 'default' && (
            <button type="button" onClick={handleEnableDesktopAlerts} className="text-sm text-primary hover:underline">
              Enable desktop alerts
            </button>
          )}
          {permission === 'granted' && <span className="text-xs text-on-surface-variant">Desktop alerts on</span>}
          <RunScanButton
            onDone={({ ok, message }) => {
              setRunNotice(ok ? `Scan finished: ${message}` : `Scan failed: ${message}`)
              if (ok) load()
            }}
          />
          {permission === 'denied' && <span className="text-xs text-on-surface-variant">Desktop alerts blocked in browser settings</span>}
          {onTabChange && (
            <button type="button" onClick={() => onTabChange('notifications')} className="px-md py-sm rounded-lg bg-primary-container text-on-primary-container text-sm font-medium">
              View alerts →
            </button>
          )}
        </div>
      </div>

      {error && <div className="text-sm text-bearish">{error}</div>}
      {runNotice && <div className="text-sm text-on-surface-variant">{runNotice}</div>}

      <section className="glass-panel rounded-xl p-md flex flex-col gap-md">
        <div className="flex items-center justify-between gap-md flex-wrap">
          <h3 className="text-sm font-semibold text-on-surface">Schedule</h3>
          <TokenBanner token={status?.token} />
        </div>
        <div className="grid gap-sm grid-cols-1 md:grid-cols-3 xl:grid-cols-5">
          {TIMEFRAME_ORDER.map((interval) => {
            const info = status?.intervals?.find((i) => i.interval === interval)
            const enabled = settings ? settings.enabledIntervals.includes(interval) : true
            return (
              <div key={interval} className={`rounded-lg bg-surface-container-low border border-outline-variant p-sm flex flex-col gap-xs ${enabled ? '' : 'opacity-60'}`}>
                <span className="text-sm font-semibold text-on-surface">{TIMEFRAME_LABELS[interval]}</span>
                <label className="flex items-center gap-xs text-xs text-on-surface-variant">
                  <input type="checkbox" checked={enabled} disabled={!settings} onChange={() => toggleSetting('enabledIntervals', interval)} />
                  Scan automatically
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
          <label className="flex items-center gap-xs text-xs text-on-surface-variant" title="Notifications, Overview and the Excel export follow this order (indices always first)">
            <input type="checkbox" checked={bulkSetOrder} onChange={(e) => setBulkSetOrder(e.target.checked)} disabled={bulkBusy} />
            Use this list as the display order
          </label>
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

        {dirty && (
          <div className="flex items-center gap-sm text-sm bg-surface-container-highest rounded-lg px-md py-xs">
            <span className="text-on-surface">Order changed - not saved yet.</span>
            <button type="button" onClick={handleSaveOrder} disabled={savingOrder} className="px-md py-xs rounded-lg bg-primary text-on-primary text-sm disabled:opacity-60">
              {savingOrder ? 'Saving…' : 'Save order'}
            </button>
            <button type="button" onClick={handleDiscardOrder} disabled={savingOrder} className="px-md py-xs rounded-lg border border-outline-variant text-on-surface text-sm">
              Discard
            </button>
          </div>
        )}
        {needle ? (
          <p className="text-xs text-on-surface-variant">Clear the filter to drag symbols into priority order.</p>
        ) : (
          <p className="text-xs text-on-surface-variant">Drag the handle on the left to set priority order (indices stay above stocks). Notifications, overview and export follow this order.</p>
        )}

        {loading ? (
          <Spinner />
        ) : (
          <div className="overflow-x-auto max-h-[60vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-on-surface-variant">
                  <th className="py-xs w-6" />
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
                  <tr
                    key={s.id}
                    onDragOver={(e) => {
                      if (!dragId) return
                      const source = symbols.find((x) => x.id === dragId)
                      if (!source || Boolean(source.isIndex) !== Boolean(s.isIndex)) return
                      e.preventDefault()
                      if (overId !== s.id) setOverId(s.id)
                    }}
                    onDrop={(e) => {
                      e.preventDefault()
                      handleDrop(s.id)
                    }}
                    className={`border-t ${overId === s.id && dragId && dragId !== s.id ? 'border-primary border-t-2' : 'border-outline-variant'} ${dragId === s.id ? 'opacity-40' : ''}`}
                  >
                    <td className="py-xs w-6">
                      {!needle && (
                        <span
                          draggable
                          onDragStart={(e) => {
                            e.dataTransfer.effectAllowed = 'move'
                            e.dataTransfer.setData('text/plain', s.id)
                            setDragId(s.id)
                          }}
                          onDragEnd={() => {
                            setDragId(null)
                            setOverId(null)
                          }}
                          className="material-symbols-outlined text-[18px] text-on-surface-variant cursor-grab active:cursor-grabbing select-none"
                          title="Drag to reorder"
                          aria-label={`Drag ${s.symbol} to reorder`}
                        >
                          drag_indicator
                        </span>
                      )}
                    </td>
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
                    <td colSpan={visibleTimeframes.length + 3} className="py-md text-center text-on-surface-variant">
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
