/**
 * Notifications page - every notification type in one place (crossover
 * alerts, Historical Watchlist "new candles" and AI-insight items, scanner
 * warnings), grouped by timeframe: 15 min, 1 hour, 4 hour, Daily, Weekly, any
 * other interval, then "System" for items with no timeframe. Within a
 * timeframe, crossovers are grouped by the bar they fired on, newest first.
 */

import { useCallback, useMemo, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { markNotificationsRead, markAllHistoricalWatchlistNotificationsRead } from '../services/api'
import { markNotificationsReadLocally, setUnreadCount } from '../store/historicalWatchlistSlice'
import { markAllReadLocally } from '../store/liveNotificationsSlice'
import { NotificationBody, notificationTitle, notificationType } from './NotificationContent'
import { TIMEFRAME_ORDER, timeframeLabel, formatCandleTime, timeAgo } from './crossoverFormat'
import Spinner from './Spinner'

// Crossover indicators, matching the labels the scanner stores in
// `indicatorLabel` (functions/crossoverScanner.js CROSSOVER_SPECS).
const INDICATOR_FILTERS = ['MACD 12/26/9', 'TSI 25/13/13', 'Stoch RSI 14/14/3/3', 'ADX 14 (+DI/-DI)', 'SMA 50/200', 'EMA 12/26']

const TYPE_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'crossover', label: 'Crossovers' },
  { key: 'candles', label: 'New candles' },
  { key: 'analysis', label: 'AI insights' },
  { key: 'scanner_warning', label: 'Warnings' },
]

const SYSTEM_KEY = 'system'

function sectionKeyOf(n) {
  return n.interval || SYSTEM_KEY
}

function sectionLabel(key) {
  return key === SYSTEM_KEY ? 'System' : timeframeLabel(key)
}

// Fixed timeframe order first, then any other interval alphabetically (the
// Historical Watchlist can use 30minute etc.), then System.
function sectionRank(key) {
  if (key === SYSTEM_KEY) return 1000
  const index = TIMEFRAME_ORDER.indexOf(key)
  return index === -1 ? 100 : index
}

// Crossovers by bar time (newest first) then symbol; everything else after,
// newest first.
function sortSectionItems(items) {
  const crossovers = items
    .filter((n) => notificationType(n) === 'crossover')
    .sort((a, b) => b.candleTimestamp - a.candleTimestamp || a.symbol.localeCompare(b.symbol) || a.indicatorLabel.localeCompare(b.indicatorLabel))
  const others = items.filter((n) => notificationType(n) !== 'crossover').sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  return [...crossovers, ...others]
}

function NotificationsTab({ onTabChange }) {
  const dispatch = useDispatch()
  // The shared live feed (useLiveNotifications, mounted in AppShell) - always in
  // sync, no polling or refresh needed here.
  const notifications = useSelector((state) => state.liveNotifications.items)
  const loading = useSelector((state) => !state.liveNotifications.loaded)
  const [typeFilter, setTypeFilter] = useState('all')
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [query, setQuery] = useState('')
  const [indicator, setIndicator] = useState('all')
  const [direction, setDirection] = useState('any')
  const [collapsed, setCollapsed] = useState(() => new Set())

  const markRead = useCallback(
    (ids) => {
      if (ids.length === 0) return
      dispatch(markNotificationsReadLocally(ids))
      for (let i = 0; i < ids.length; i += 500) {
        markNotificationsRead(ids.slice(i, i + 500)).catch((err) => console.error('Failed to mark notifications read:', err))
      }
    },
    [dispatch]
  )

  const markAllRead = () => {
    dispatch(markAllReadLocally())
    dispatch(setUnreadCount(0))
    markAllHistoricalWatchlistNotificationsRead().catch((err) => console.error('Failed to mark all notifications read:', err))
  }

  const toggleSection = (key) =>
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const unreadTotal = notifications.filter((n) => !n.read).length
  const typeCounts = useMemo(() => {
    const counts = { all: notifications.length }
    for (const n of notifications) counts[notificationType(n)] = (counts[notificationType(n)] || 0) + 1
    return counts
  }, [notifications])

  const sections = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const visible = notifications.filter(
      (n) => (typeFilter === 'all' || notificationType(n) === typeFilter) &&
        (!unreadOnly || !n.read) &&
        (!needle || (n.symbol || '').toLowerCase().includes(needle)) &&
        (indicator === 'all' || n.indicatorLabel === indicator) &&
        (direction === 'any' || n.direction === direction)
    )
    const byKey = new Map()
    for (const n of visible) {
      const key = sectionKeyOf(n)
      if (!byKey.has(key)) byKey.set(key, [])
      byKey.get(key).push(n)
    }
    return [...byKey.entries()]
      .sort(([a], [b]) => sectionRank(a) - sectionRank(b) || a.localeCompare(b))
      .map(([key, items]) => ({ key, label: sectionLabel(key), items: sortSectionItems(items), unread: items.filter((n) => !n.read).length }))
  }, [notifications, typeFilter, unreadOnly, query, indicator, direction])

  return (
    <div className="flex flex-col gap-lg">
      <div className="flex items-center justify-between gap-md flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-on-surface">Notifications</h2>
          <p className="text-xs text-on-surface-variant">
            {unreadTotal} unread of {notifications.length} loaded · live · grouped by timeframe
          </p>
        </div>
        <div className="flex items-center gap-md">
          {onTabChange && (
            <button type="button" onClick={() => onTabChange('crossover-scanner')} className="text-sm text-primary hover:underline">
              Scanner settings →
            </button>
          )}
          <button
            type="button"
            onClick={markAllRead}
            disabled={unreadTotal === 0}
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
            {f.label} {typeCounts[f.key] ? `(${typeCounts[f.key]})` : ''}
          </button>
        ))}
        <label className="flex items-center gap-xs text-xs text-on-surface-variant ml-md">
          <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />
          Unread only
        </label>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by symbol…"
          className="bg-surface-container-low border border-terminal-border rounded-lg text-sm px-md py-xs text-on-surface"
        />
        <select value={indicator} onChange={(e) => setIndicator(e.target.value)} className="bg-surface-container-low border border-terminal-border rounded-lg text-sm px-md py-xs text-on-surface" aria-label="Crossover indicator">
          <option value="all">All indicators</option>
          {INDICATOR_FILTERS.map((label) => (
            <option key={label} value={label}>
              {label}
            </option>
          ))}
        </select>
        <select value={direction} onChange={(e) => setDirection(e.target.value)} className="bg-surface-container-low border border-terminal-border rounded-lg text-sm px-md py-xs text-on-surface" aria-label="Crossover direction">
          <option value="any">Any direction</option>
          <option value="bullish">Bullish</option>
          <option value="bearish">Bearish</option>
        </select>
      </div>

      {loading && <Spinner />}
      {!loading && sections.length === 0 && <div className="glass-panel rounded-xl p-lg text-center text-sm text-on-surface-variant">No notifications match.</div>}

      {sections.map((section) => {
        const isCollapsed = collapsed.has(section.key)
        let lastBar = null
        return (
          <section key={section.key} className="glass-panel rounded-xl">
            <div className="flex items-center justify-between gap-md p-md">
              <button type="button" onClick={() => toggleSection(section.key)} className="flex items-center gap-sm text-left" aria-expanded={!isCollapsed}>
                <span className="material-symbols-outlined text-on-surface-variant">{isCollapsed ? 'chevron_right' : 'expand_more'}</span>
                <span className="text-sm font-semibold text-on-surface">{section.label}</span>
                <span className="text-xs text-on-surface-variant">{section.items.length}</span>
                {section.unread > 0 && <span className="min-w-[18px] h-[18px] px-[5px] rounded-full bg-error text-on-error text-[10px] font-bold flex items-center justify-center">{section.unread}</span>}
              </button>
              {section.unread > 0 && (
                <button
                  type="button"
                  onClick={() => markRead(section.items.filter((n) => !n.read).map((n) => n.id))}
                  className="text-xs text-primary hover:underline"
                >
                  Mark {section.label} read
                </button>
              )}
            </div>

            {!isCollapsed && (
              <ul className="px-md pb-md flex flex-col gap-xs">
                {section.items.map((n) => {
                  const barKey = notificationType(n) === 'crossover' ? n.candleTimestamp : null
                  const showBarHeader = barKey != null && barKey !== lastBar
                  lastBar = barKey
                  return (
                    <li key={n.id}>
                      {showBarHeader && <div className="text-[11px] uppercase tracking-wide text-on-surface-variant pt-sm pb-xs">Bar {formatCandleTime(barKey)} IST</div>}
                      <div
                        onClick={() => !n.read && markRead([n.id])}
                        className={`px-sm py-xs rounded-lg text-sm ${n.read ? 'text-on-surface-variant' : 'text-on-surface bg-surface-container-highest cursor-pointer'}`}
                      >
                        <div className="flex items-center justify-between gap-sm">
                          <span className="font-medium flex items-center gap-xs">
                            {!n.read && <span className="w-2 h-2 rounded-full bg-primary inline-block" aria-label="unread" />}
                            {notificationTitle(n)}
                          </span>
                          <span className="text-[10px] text-on-surface-variant">{timeAgo(n.createdAt)}</span>
                        </div>
                        <div className="text-xs text-on-surface-variant">
                          <NotificationBody n={n} />
                        </div>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        )
      })}

    </div>
  )
}

export default NotificationsTab
