/**
 * Notifications page - every notification type in one place (crossover
 * alerts, Historical Watchlist "new candles" and AI-insight items, scanner
 * warnings), grouped by timeframe: 15 min, 1 hour, 4 hour, Daily, Weekly, then
 * "System". Each section is paged on the SERVER (numbered pages of PAGE_SIZE)
 * so every stored notification is reachable, and loads only when opened.
 * Each timeframe header carries bullish / bearish overview cards. Filters (incl.
 * a from/to date range) are sent to the server too, so totals and pages always agree.
 * Sections start collapsed. The tab stays in sync by itself: whenever the
 * shared live feed (useLiveNotifications) sees something new, the section
 * counts and the open sections' first page are re-fetched.
 *
 * Timeframe sections show crossovers MERGED: one card per symbol + bar with
 * every indicator that crossed, a star per indicator, and the ADX at that bar
 * (CrossoverGroupCard). Index symbols (NIFTY, BANKNIFTY, ...) are pinned first
 * in every section; the rest follow newest bar first, then the uploaded list
 * order. "Run now" scans immediately; "Export to Excel" downloads the
 * Notification List template filled for the chosen dates (default today).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import {
  markNotificationsRead,
  markAllNotificationsRead,
  getNotificationsPage,
  getNotificationGroups,
  getNotificationCounts,
  getUnreadNotificationCount,
  previewDeleteNotifications,
  deleteNotifications,
  exportNotificationsExcel,
} from '../services/api'
import { markNotificationsReadLocally, setUnreadCount } from '../store/historicalWatchlistSlice'
import { markAllReadLocally, removeNotificationsInRange } from '../store/liveNotificationsSlice'
import { NotificationBody, notificationTitle, notificationType } from './NotificationContent'
import { TIMEFRAME_ORDER, timeframeLabel, crossoverTimestamp, formatCrossoverTime, timeAgo } from './crossoverFormat'
import Spinner from './Spinner'
import CrossoverGroupCard from './CrossoverGroupCard'
import RunScanButton from './RunScanButton'

// Crossover indicators, matching the labels the scanner stores in
// `indicatorLabel` (functions/crossoverScanner.js CROSSOVER_SPECS).
// DMI = the +DI/-DI crossover (formerly labelled "ADX"; the server also matches
// the old label). The ADX line itself is shown on every card, not filtered.
const INDICATOR_FILTERS = ['MACD 12/26/9', 'TSI 25/13/13', 'Stoch RSI 14/14/3/3', 'DMI 14 (+DI/-DI)', 'RSI 14/14', 'SMA 50/200', 'EMA 12/26']

const TYPE_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'crossover', label: 'Crossovers' },
  { key: 'candles', label: 'New candles' },
  { key: 'analysis', label: 'AI insights' },
  { key: 'scanner_warning', label: 'Warnings' },
]

const SYSTEM_KEY = 'system'
const SECTION_ORDER = [...TIMEFRAME_ORDER, SYSTEM_KEY]
const PAGE_SIZE = 25
const SYMBOL_DEBOUNCE_MS = 300

function sectionLabel(key) {
  return key === SYSTEM_KEY ? 'System' : timeframeLabel(key)
}

// Page numbers to show: first, last, and a window around the current page, with
// null marking a gap ("…").
function pageWindow(page, totalPages) {
  const wanted = new Set([1, totalPages, page - 1, page, page + 1])
  const numbers = [...wanted].filter((n) => n >= 1 && n <= totalPages).sort((x, y) => x - y)
  return numbers.flatMap((n, i) => (i > 0 && n - numbers[i - 1] > 1 ? [null, n] : [n]))
}

function Pagination({ page, total, onChange }) {
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  if (totalPages <= 1) return null
  const button = 'min-w-[28px] px-xs py-[2px] rounded text-xs border border-outline-variant'
  return (
    <div className="flex items-center gap-xs flex-wrap pt-sm" role="navigation" aria-label="Pages">
      <button type="button" disabled={page <= 1} onClick={() => onChange(page - 1)} className={`${button} text-on-surface-variant disabled:opacity-40`}>
        Prev
      </button>
      {pageWindow(page, totalPages).map((n, i) =>
        n == null ? (
          <span key={`gap-${i}`} className="text-xs text-on-surface-variant">
            …
          </span>
        ) : (
          <button key={n} type="button" onClick={() => onChange(n)} aria-current={n === page ? 'page' : undefined} className={`${button} ${n === page ? 'bg-primary-container text-on-primary-container border-transparent' : 'text-on-surface-variant hover:text-on-surface'}`}>
            {n}
          </button>
        )
      )}
      <button type="button" disabled={page >= totalPages} onClick={() => onChange(page + 1)} className={`${button} text-on-surface-variant disabled:opacity-40`}>
        Next
      </button>
      <span className="text-[11px] text-on-surface-variant ml-sm">
        Page {page} of {totalPages} · {total} total
      </span>
    </div>
  )
}

// Crossovers by bar time (newest first) then symbol; everything else after,
// newest first.
function sortSectionItems(items) {
  const crossovers = items
    .filter((n) => notificationType(n) === 'crossover')
    .sort((a, b) => crossoverTimestamp(b) - crossoverTimestamp(a) || a.symbol.localeCompare(b.symbol) || a.indicatorLabel.localeCompare(b.indicatorLabel))
  const others = items.filter((n) => notificationType(n) !== 'crossover').sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  return [...crossovers, ...others]
}

// Timeframe sections list merged crossover groups unless the type filter asks
// for a non-crossover type (new candles / AI insights), which keep the per-item list.
const isGroupedSection = (section, typeFilter) => section !== SYSTEM_KEY && (typeFilter === 'all' || typeFilter === 'crossover')

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

// Local-time day bounds as ISO strings for the API ('' stays '').
const startOfDayIso = (value) => (value ? new Date(`${value}T00:00:00`).toISOString() : '')
const endOfDayIso = (value) => (value ? new Date(`${value}T23:59:59.999`).toISOString() : '')

// Checkbox dropdown for choosing any number of indicators (none = all).
function IndicatorMultiSelect({ selected, onChange, className }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return undefined
    const close = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  const toggle = (label) => onChange(selected.includes(label) ? selected.filter((l) => l !== label) : [...selected, label])
  const text = selected.length === 0 ? 'All indicators' : selected.length === 1 ? selected[0] : `${selected.length} indicators`
  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen((o) => !o)} className={`${className} flex items-center gap-xs`} aria-haspopup="listbox" aria-expanded={open} aria-label="Crossover indicators">
        {text}
        <span className="material-symbols-outlined text-[16px]">expand_more</span>
      </button>
      {open && (
        <div className="absolute z-50 mt-xs min-w-[220px] glass-panel bg-surface rounded-lg border border-outline-variant p-sm flex flex-col gap-xs shadow-lg">
          {INDICATOR_FILTERS.map((label) => (
            <label key={label} className="flex items-center gap-xs text-sm text-on-surface cursor-pointer">
              <input type="checkbox" checked={selected.includes(label)} onChange={() => toggle(label)} />
              {label}
            </label>
          ))}
          {selected.length > 0 && (
            <button type="button" onClick={() => onChange([])} className="text-xs text-primary hover:underline text-left pt-xs">
              Clear selection
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function CountCard({ label, value, unread, tone }) {
  return (
    <div className={`flex items-center gap-xs rounded-lg border border-outline-variant px-sm py-[2px] ${tone === 'bullish' ? 'bg-bullish/10' : 'bg-bearish/10'}`}>
      <span className={`text-[11px] uppercase tracking-wide ${tone === 'bullish' ? 'text-bullish' : 'text-bearish'}`}>{label}</span>
      <span className="text-sm font-semibold font-mono text-on-surface">{value}</span>
      <span className="text-[10px] text-on-surface-variant">{unread} unread</span>
    </div>
  )
}

// Bullish vs bearish share of a section as a split bar + percentage.
function BiasBar({ bullish, bearish }) {
  const sum = bullish + bearish
  if (sum === 0) return null
  const bullPct = Math.round((bullish / sum) * 100)
  return (
    <div className="flex items-center gap-xs" title={`${bullPct}% bullish / ${100 - bullPct}% bearish`}>
      <div className="flex w-24 h-2 rounded-full overflow-hidden bg-bearish/60">
        <div className="bg-bullish" style={{ width: `${bullPct}%` }} />
      </div>
      <span className="text-[10px] text-on-surface-variant font-mono">{bullPct}% bull</span>
    </div>
  )
}

// Delete notifications by date range + sections, with a live preview count.
function DeleteDialog({ onClose, onDeleted }) {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [picked, setPicked] = useState(() => new Set())
  const [count, setCount] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const ready = from && to && picked.size > 0 && from <= to

  useEffect(() => {
    setCount(null)
    if (!ready) return undefined
    let cancelled = false
    previewDeleteNotifications({ from: startOfDayIso(from), to: endOfDayIso(to), intervals: [...picked] })
      .then((data) => !cancelled && setCount(data.count))
      .catch((err) => !cancelled && setError(err?.response?.data?.error || err?.message || 'Preview failed'))
    return () => {
      cancelled = true
    }
  }, [from, to, picked, ready])

  const toggle = (key) =>
    setPicked((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const confirm = async () => {
    setBusy(true)
    setError('')
    try {
      const body = { from: startOfDayIso(from), to: endOfDayIso(to), intervals: [...picked] }
      let deleted = 0
      for (let i = 0; i < 50; i++) {
        const result = await deleteNotifications(body)
        deleted += result.deleted
        if (!result.hasMore) break
      }
      onDeleted({ deleted, ...body })
    } catch (err) {
      setError(err?.response?.data?.error || err?.message || 'Delete failed')
      setBusy(false)
    }
  }

  const inputClass = 'bg-surface-container-low border border-terminal-border rounded-lg text-sm px-md py-xs text-on-surface'
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-md" role="dialog" aria-modal="true" aria-label="Delete notifications">
      <div className="glass-panel rounded-xl p-lg w-full max-w-md flex flex-col gap-md bg-surface">
        <h3 className="text-base font-semibold text-on-surface">Delete notifications</h3>
        <div className="flex items-center gap-sm flex-wrap">
          <label className="flex flex-col text-xs text-on-surface-variant gap-xs">
            From
            <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className={inputClass} />
          </label>
          <label className="flex flex-col text-xs text-on-surface-variant gap-xs">
            To
            <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className={inputClass} />
          </label>
        </div>
        <fieldset className="flex flex-wrap gap-sm">
          <legend className="text-xs text-on-surface-variant pb-xs">Intervals</legend>
          {SECTION_ORDER.map((key) => (
            <label key={key} className="flex items-center gap-xs text-sm text-on-surface">
              <input type="checkbox" checked={picked.has(key)} onChange={() => toggle(key)} />
              {sectionLabel(key)}
            </label>
          ))}
        </fieldset>
        <p className="text-sm text-on-surface-variant">
          {!ready ? 'Pick both dates and at least one interval.' : count == null ? 'Counting…' : `${count} notification${count === 1 ? '' : 's'} will be permanently deleted (by crossover date).`}
        </p>
        {error && <div className="text-sm text-bearish">{error}</div>}
        <div className="flex justify-end gap-sm">
          <button type="button" onClick={onClose} disabled={busy} className="px-md py-sm rounded-lg text-sm border border-outline-variant text-on-surface-variant">
            Cancel
          </button>
          <button type="button" onClick={confirm} disabled={busy || !ready || !count} className="px-md py-sm rounded-lg text-sm font-medium bg-error text-on-error disabled:opacity-50">
            {busy ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  )
}

function NotificationsTab({ onTabChange }) {
  const dispatch = useDispatch()
  // Shared live feed: used only as a change signal (newest createdAt) and to
  // reflect read-state changes made elsewhere (popup, bell).
  const feed = useSelector((state) => state.liveNotifications.items)
  const liveCursor = useSelector((state) => state.liveNotifications.cursor)
  const unreadBadge = useSelector((state) => state.historicalWatchlist.unreadCount)
  const readIds = useMemo(() => new Set(feed.filter((n) => n.read).map((n) => n.id)), [feed])

  const [typeFilter, setTypeFilter] = useState('all')
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [symbolInput, setSymbolInput] = useState('')
  const [symbol, setSymbol] = useState('')
  const [indicators, setIndicators] = useState([]) // selected indicator labels, [] = all
  const [direction, setDirection] = useState('any')
  const [fromDate, setFromDate] = useState('') // yyyy-mm-dd (local), '' = no bound
  const [toDate, setToDate] = useState('')
  const [showDelete, setShowDelete] = useState(false)
  const [notice, setNotice] = useState('')
  const [exporting, setExporting] = useState(false)
  // Sections start collapsed; only the ones the user opens are tracked.
  const [expanded, setExpanded] = useState(() => new Set())
  const [pages, setPages] = useState({}) // section -> current page (default 1)
  const [counts, setCounts] = useState(null) // section -> {total, unread}
  const [sectionData, setSectionData] = useState({}) // section -> {key, items, total, loading, error}
  const [error, setError] = useState('')

  useEffect(() => {
    const id = setTimeout(() => setSymbol(symbolInput.trim().toUpperCase()), SYMBOL_DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [symbolInput])

  // The filters as request params (and a stable key to detect changes).
  const filters = useMemo(() => {
    const f = {}
    if (typeFilter !== 'all') f.type = typeFilter
    if (unreadOnly) f.unreadOnly = true
    if (symbol) f.symbol = symbol
    if (indicators.length) f.indicator = indicators.join(',')
    if (direction !== 'any') f.direction = direction
    if (fromDate) f.from = startOfDayIso(fromDate)
    if (toDate) f.to = endOfDayIso(toDate)
    return f
  }, [typeFilter, unreadOnly, symbol, indicators, direction, fromDate, toDate])
  const filtersKey = JSON.stringify(filters)
  const filtersRef = useRef(filters)
  filtersRef.current = filters
  const typeFilterRef = useRef(typeFilter)
  typeFilterRef.current = typeFilter

  // A filter change goes back to page 1 everywhere.
  useEffect(() => {
    setPages({})
  }, [filtersKey])

  const loadCounts = useCallback(async () => {
    const key = JSON.stringify(filtersRef.current)
    try {
      const { sections } = await getNotificationCounts(filtersRef.current)
      if (JSON.stringify(filtersRef.current) === key) {
        setCounts(sections)
        setError('')
      }
    } catch (err) {
      setError(err?.response?.data?.error || err?.message || 'Failed to load notifications')
    }
  }, [])

  const loadSection = useCallback(async (section, page) => {
    const key = `${JSON.stringify(filtersRef.current)}|${page}`
    setSectionData((current) => ({ ...current, [section]: { ...current[section], key, loading: true, error: '' } }))
    try {
      const grouped = isGroupedSection(section, typeFilterRef.current)
      const data = grouped ? await getNotificationGroups(section, filtersRef.current, page, PAGE_SIZE) : await getNotificationsPage(section, filtersRef.current, page, PAGE_SIZE)
      const items = grouped ? data.groups : data.notifications
      setSectionData((current) => (current[section]?.key === key ? { ...current, [section]: { key, grouped, items, total: data.total, loading: false, error: '' } } : current))
    } catch (err) {
      setSectionData((current) => (current[section]?.key === key ? { ...current, [section]: { ...current[section], loading: false, error: err?.response?.data?.error || err?.message || 'Failed to load' } } : current))
    }
  }, [])

  // Counts: on mount, when filters change, and whenever the live feed or the
  // unread badge moves (new crossover arrived / something marked read).
  useEffect(() => {
    loadCounts()
  }, [filtersKey, liveCursor, unreadBadge, loadCounts])

  // Open sections load their current page when opened / paged / re-filtered.
  useEffect(() => {
    for (const section of expanded) {
      const page = pages[section] || 1
      if (sectionData[section]?.key !== `${filtersKey}|${page}`) loadSection(section, page)
    }
  }, [expanded, pages, filtersKey, sectionData, loadSection])

  // Live: a new notification refreshes the open sections that show page 1 (later
  // pages are left alone so the page does not shift under the reader).
  const lastCursorRef = useRef(liveCursor)
  useEffect(() => {
    if (lastCursorRef.current === liveCursor) return
    lastCursorRef.current = liveCursor
    for (const section of expanded) {
      if ((pages[section] || 1) === 1) loadSection(section, 1)
    }
  }, [liveCursor, expanded, pages, loadSection])

  // ids = notification ids, groupIds = merged-card ids (a card's notifications
  // are marked read with it, so the bell count stays right).
  const markRead = useCallback(
    (ids, groupIds = []) => {
      if (ids.length === 0 && groupIds.length === 0) return
      const idSet = new Set([...ids, ...groupIds])
      dispatch(markNotificationsReadLocally(ids))
      setSectionData((current) =>
        Object.fromEntries(Object.entries(current).map(([key, data]) => [key, data.items ? { ...data, items: data.items.map((n) => (idSet.has(n.id) ? { ...n, read: true } : n)) } : data]))
      )
      for (let i = 0; i < Math.max(ids.length, groupIds.length); i += 450) {
        markNotificationsRead(ids.slice(i, i + 450), groupIds.slice(i, i + 450)).catch((err) => console.error('Failed to mark notifications read:', err))
      }
    },
    [dispatch]
  )

  const groupIsRead = useCallback((g) => g.read || (g.notificationIds?.length > 0 && g.notificationIds.every((id) => readIds.has(id))), [readIds])
  const openGroup = useCallback((g) => markRead(g.notificationIds || [], [g.id]), [markRead])

  const refreshAll = useCallback(() => {
    loadCounts()
    setSectionData({})
  }, [loadCounts])

  const handleRunDone = ({ ok, message }) => {
    setNotice(ok ? `Scan finished: ${message}` : `Scan failed: ${message}`)
    if (ok) refreshAll()
  }

  const handleExport = async () => {
    setExporting(true)
    try {
      const { blob, filename } = await exportNotificationsExcel({ from: fromDate ? startOfDayIso(fromDate) : undefined, to: toDate ? endOfDayIso(toDate) : undefined })
      downloadBlob(blob, filename)
      setNotice(`Exported ${fromDate || toDate ? `${fromDate || '…'} to ${toDate || 'now'}` : "today's crossovers"} to ${filename}.`)
    } catch (err) {
      setNotice(`Export failed: ${err?.response?.data?.error || err?.message || 'unknown error'}`)
    } finally {
      setExporting(false)
    }
  }

  const markAllRead = () => {
    dispatch(markAllReadLocally())
    dispatch(setUnreadCount(0))
    markAllNotificationsRead()
      .then(() => {
        loadCounts()
        expanded.forEach((section) => loadSection(section, pages[section] || 1))
      })
      .catch((err) => console.error('Failed to mark all notifications read:', err))
  }

  const handleDeleted = ({ deleted, intervals, from, to }) => {
    setShowDelete(false)
    setNotice(`Deleted ${deleted} notification${deleted === 1 ? '' : 's'}.`)
    dispatch(removeNotificationsInRange({ sections: intervals, from, to }))
    getUnreadNotificationCount()
      .then(({ count }) => dispatch(setUnreadCount(count || 0)))
      .catch((err) => console.error('Failed to refresh unread count:', err))
    setPages({})
    setSectionData({})
    loadCounts()
  }

  const toggleSection = (key) =>
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const setSectionPage = (section, page) => setPages((current) => ({ ...current, [section]: page }))

  const unreadTotal = counts ? Object.values(counts).reduce((sum, c) => sum + c.unread, 0) : 0
  const grandTotal = counts ? Object.values(counts).reduce((sum, c) => sum + c.total, 0) : 0
  const visibleSections = SECTION_ORDER.filter((key) => (counts?.[key]?.total || 0) > 0)

  const selectClass = 'bg-surface-container-low border border-terminal-border rounded-lg text-sm px-md py-xs text-on-surface'

  return (
    <div className="flex flex-col gap-lg">
      <div className="flex items-center justify-between gap-md flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-on-surface">Notifications</h2>
          <p className="text-xs text-on-surface-variant">
            {counts ? `${unreadTotal} unread of ${grandTotal} matching` : 'Loading…'} · live · grouped by timeframe · {PAGE_SIZE} per page
          </p>
        </div>
        <div className="flex items-center gap-md flex-wrap">
          <RunScanButton onDone={handleRunDone} />
          <button
            type="button"
            onClick={handleExport}
            disabled={exporting}
            title={fromDate || toDate ? 'Export the chosen date range' : "Export today's crossovers (pick From/To to change)"}
            className="px-md py-sm rounded-lg border border-outline-variant text-sm text-on-surface flex items-center gap-xs disabled:opacity-60"
          >
            {exporting ? <Spinner /> : <span className="material-symbols-outlined text-[18px]">download</span>}
            Export to Excel
          </button>
          {onTabChange && (
            <button type="button" onClick={() => onTabChange('crossover-scanner')} className="text-sm text-primary hover:underline">
              Scanner settings →
            </button>
          )}
          <button type="button" onClick={() => setShowDelete(true)} className="px-md py-sm rounded-lg border border-outline-variant text-sm text-bearish">
            Delete notifications…
          </button>
          <button
            type="button"
            onClick={markAllRead}
            disabled={unreadBadge === 0 && unreadTotal === 0}
            className="px-md py-sm rounded-lg bg-primary-container text-on-primary-container text-sm font-medium disabled:opacity-50"
          >
            Mark all read
          </button>
        </div>
      </div>

      <div className="flex items-center gap-sm flex-wrap">
        {TYPE_FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setTypeFilter(f.key)}
            className={`px-md py-xs rounded-full text-xs border ${
              typeFilter === f.key ? 'bg-primary-container text-on-primary-container border-transparent' : 'border-outline-variant text-on-surface-variant hover:text-on-surface'
            }`}
          >
            {f.label}
          </button>
        ))}
        <label className="flex items-center gap-xs text-xs text-on-surface-variant ml-md">
          <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />
          Unread only
        </label>
        <input type="text" value={symbolInput} onChange={(e) => setSymbolInput(e.target.value)} placeholder="Symbol (exact, e.g. ABB)…" className={selectClass} aria-label="Filter by symbol" />
        <IndicatorMultiSelect selected={indicators} onChange={setIndicators} className={selectClass} />
        <select value={direction} onChange={(e) => setDirection(e.target.value)} className={selectClass} aria-label="Crossover direction">
          <option value="any">Any direction</option>
          <option value="bullish">Bullish</option>
          <option value="bearish">Bearish</option>
        </select>
        <label className="flex items-center gap-xs text-xs text-on-surface-variant" title="Filters by crossover time">
          From
          <input type="date" value={fromDate} max={toDate || undefined} onChange={(e) => setFromDate(e.target.value)} className={selectClass} aria-label="From date" />
        </label>
        <label className="flex items-center gap-xs text-xs text-on-surface-variant" title="Filters by crossover time">
          To
          <input type="date" value={toDate} min={fromDate || undefined} onChange={(e) => setToDate(e.target.value)} className={selectClass} aria-label="To date" />
        </label>
        {(fromDate || toDate) && (
          <button type="button" onClick={() => { setFromDate(''); setToDate('') }} className="text-xs text-primary hover:underline">
            Clear dates
          </button>
        )}
      </div>

      {notice && <div className="text-sm text-on-surface-variant">{notice}</div>}
      {showDelete && <DeleteDialog onClose={() => setShowDelete(false)} onDeleted={handleDeleted} />}

      {error && <div className="text-sm text-bearish">{error}</div>}
      {!counts && !error && <Spinner />}
      {counts && visibleSections.length === 0 && <div className="glass-panel rounded-xl p-lg text-center text-sm text-on-surface-variant">No notifications match.</div>}

      {visibleSections.map((key) => {
        const isCollapsed = !expanded.has(key)
        const page = pages[key] || 1
        const { total, unread, bullish = 0, bearish = 0, unreadBullish = 0, unreadBearish = 0, lastCrossover = null } = counts[key]
        const data = sectionData[key]
        const grouped = Boolean(data?.grouped)
        // Groups arrive in server order (indices first); single items are sorted here.
        const items = data?.items ? (grouped ? data.items : sortSectionItems(data.items)) : []
        const unreadGroups = grouped ? items.filter((g) => !groupIsRead(g)) : []
        let lastBar = null
        let lastHeader = null
        return (
          <section key={key} className="glass-panel rounded-xl">
            <div className="flex items-center justify-between gap-md p-md">
              <button type="button" onClick={() => toggleSection(key)} className="flex items-center gap-sm text-left" aria-expanded={!isCollapsed}>
                <span className="material-symbols-outlined text-on-surface-variant">{isCollapsed ? 'chevron_right' : 'expand_more'}</span>
                <span className="text-sm font-semibold text-on-surface">{sectionLabel(key)}</span>
                <span className="text-xs text-on-surface-variant">{total}</span>
                {unread > 0 && <span className="min-w-[18px] h-[18px] px-[5px] rounded-full bg-error text-on-error text-[10px] font-bold flex items-center justify-center">{unread}</span>}
              </button>
              {key !== SYSTEM_KEY && (
                <div className="flex items-center gap-sm ml-auto">
                  <BiasBar bullish={bullish} bearish={bearish} />
                  {lastCrossover != null && <span className="text-[10px] text-on-surface-variant">Last crossover {timeAgo(new Date(lastCrossover * 1000).toISOString())}</span>}
                  <CountCard label="Bullish" value={bullish} unread={unreadBullish} tone="bullish" />
                  <CountCard label="Bearish" value={bearish} unread={unreadBearish} tone="bearish" />
                </div>
              )}
              {!isCollapsed && grouped && unreadGroups.length > 0 && (
                <button type="button" onClick={() => markRead(unreadGroups.flatMap((g) => g.notificationIds || []), unreadGroups.map((g) => g.id))} className="text-xs text-primary hover:underline">
                  Mark this page read
                </button>
              )}
              {!isCollapsed && !grouped && items.some((n) => !n.read && !readIds.has(n.id)) && (
                <button type="button" onClick={() => markRead(items.filter((n) => !n.read && !readIds.has(n.id)).map((n) => n.id))} className="text-xs text-primary hover:underline">
                  Mark this page read
                </button>
              )}
            </div>

            {!isCollapsed && (
              <div className="px-md pb-md">
                {data?.loading && items.length === 0 && <Spinner />}
                {data?.error && <div className="text-sm text-bearish">{data.error}</div>}
                {grouped && !data?.loading && items.length === 0 && <div className="text-sm text-on-surface-variant">No crossovers match on this page.</div>}
                <ul className="flex flex-col gap-xs">
                  {grouped &&
                    items.map((g) => {
                      // Sub-headers: "Indices" once for the pinned index cards, then one per bar time.
                      const header = g.isIndex ? 'Indices' : `Crossed ${formatCrossoverTime(g)}`
                      const showHeader = header !== lastHeader
                      lastHeader = header
                      return (
                        <li key={g.id}>
                          {showHeader && <div className="text-[11px] uppercase tracking-wide text-on-surface-variant pt-sm pb-xs">{header}</div>}
                          <CrossoverGroupCard group={g} isRead={groupIsRead(g)} onOpen={openGroup} />
                        </li>
                      )
                    })}
                  {!grouped && items.map((n) => {
                    const isRead = n.read || readIds.has(n.id)
                    const barKey = notificationType(n) === 'crossover' ? crossoverTimestamp(n) : null
                    const showBarHeader = barKey != null && barKey !== lastBar
                    lastBar = barKey
                    return (
                      <li key={n.id}>
                        {showBarHeader && <div className="text-[11px] uppercase tracking-wide text-on-surface-variant pt-sm pb-xs">Crossed {formatCrossoverTime(n)}</div>}
                        <div
                          onClick={() => !isRead && markRead([n.id])}
                          className={`px-sm py-xs rounded-lg text-sm ${isRead ? 'text-on-surface-variant' : 'text-on-surface bg-surface-container-highest cursor-pointer'}`}
                        >
                          <div className="flex items-center justify-between gap-sm">
                            <span className="font-medium flex items-center gap-xs">
                              {!isRead && <span className="w-2 h-2 rounded-full bg-primary inline-block" aria-label="unread" />}
                              {notificationTitle(n)}
                            </span>
                            <span className="text-[10px] text-on-surface-variant">{notificationType(n) === 'crossover' ? formatCrossoverTime(n) : timeAgo(n.createdAt)}</span>
                          </div>
                          <div className="text-xs text-on-surface-variant">
                            <NotificationBody n={n} />
                          </div>
                        </div>
                      </li>
                    )
                  })}
                </ul>
                <Pagination page={page} total={data?.total ?? total} onChange={(next) => setSectionPage(key, next)} />
                {grouped && data?.total != null && <div className="text-[10px] text-on-surface-variant pt-xs">{data.total} card{data.total === 1 ? '' : 's'} ({total} crossovers) · ★ = indicators that crossed on the same bar</div>}
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}

export default NotificationsTab
