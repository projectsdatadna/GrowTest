/**
 * Popup for new crossover alerts. Mounted once in AppShell so it works on
 * every tab. It does no fetching of its own: it reads the shared live feed
 * (useLiveNotifications, polled every few seconds) and opens one modal listing
 * every UNREAD crossover, grouped by symbol, with all the details (indicator,
 * bar time, close, line values, confluence). Crossovers are appended to the
 * open modal the moment they arrive, so it fills up live while a scan runs.
 *
 * "Unread" is the only state: dismissing marks exactly the shown ids read
 * (the same read route the bell uses), so nothing re-opens afterwards, and
 * alerts missed while the app was closed show up on the next load. New
 * arrivals also beep, and fire a native browser notification when the tab is
 * hidden (if the user enabled it from the Crossover Scanner tab).
 */

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useDispatch, useSelector } from 'react-redux'
import { markNotificationsRead } from '../services/api'
import { markNotificationsReadLocally } from '../store/historicalWatchlistSlice'
import { formatCandleTime, formatLines, showBrowserNotification, playAlertBeep, timeframeLabel, TIMEFRAME_ORDER } from './crossoverFormat'

// Fallback until the server says which timeframes should pop up (the live feed
// returns popupIntervals). Mirrors the server default.
const DEFAULT_POPUP_INTERVALS = TIMEFRAME_ORDER

const timeframeRank = (interval) => {
  const index = TIMEFRAME_ORDER.indexOf(interval)
  return index === -1 ? TIMEFRAME_ORDER.length : index
}

function directionBadge(direction) {
  return direction === 'bullish' ? (
    <span className="text-bullish font-semibold">▲ Bullish</span>
  ) : (
    <span className="text-bearish font-semibold">▼ Bearish</span>
  )
}

// One card per symbol; symbols with the most same-direction crossovers first
// (several indicators agreeing is the strongest signal).
function groupBySymbol(items) {
  const groups = new Map()
  for (const item of items) {
    const key = `${item.exchange}:${item.symbol}`
    if (!groups.has(key)) groups.set(key, { key, symbol: item.symbol, exchange: item.exchange, items: [] })
    groups.get(key).items.push(item)
  }
  const result = [...groups.values()]
  for (const group of result) {
    const bullish = group.items.filter((i) => i.direction === 'bullish').length
    group.bullish = bullish
    group.bearish = group.items.length - bullish
    group.strength = Math.max(group.bullish, group.bearish)
    group.items.sort((a, b) => timeframeRank(a.interval) - timeframeRank(b.interval) || b.candleTimestamp - a.candleTimestamp || a.indicatorLabel.localeCompare(b.indicatorLabel))
  }
  return result.sort((a, b) => b.strength - a.strength || a.symbol.localeCompare(b.symbol))
}

function summarizeForBrowser(items) {
  const groups = groupBySymbol(items)
  const names = groups
    .slice(0, 4)
    .map((g) => `${g.symbol} ${g.bullish >= g.bearish ? '▲' : '▼'}`)
    .join(', ')
  const more = groups.length > 4 ? ` +${groups.length - 4} more` : ''
  return {
    title: `${items.length} crossover${items.length === 1 ? '' : 's'}: ${names}${more}`,
    body: items
      .slice(0, 4)
      .map((i) => `${i.symbol} ${timeframeLabel(i.interval)} ${i.indicatorLabel} ${i.direction}`)
      .join('\n'),
  }
}

function CrossoverAlertPopup({ onViewNotifications }) {
  const dispatch = useDispatch()
  const feed = useSelector((state) => state.liveNotifications.items)
  const popupIntervals = useSelector((state) => state.liveNotifications.popupIntervals)
  const minAgreement = useSelector((state) => state.liveNotifications.minAgreement)
  // Ids already announced via browser notification/beep.
  const announcedRef = useRef(new Set())

  // Every unread crossover on a popup timeframe with enough agreeing
  // indicators. Dismissed ones are marked read in the feed, so they drop out.
  const items = useMemo(() => {
    const popupSet = new Set(popupIntervals || DEFAULT_POPUP_INTERVALS)
    return feed.filter((n) => n.type === 'crossover' && !n.read && popupSet.has(n.interval) && (n.agreement ?? 1) >= (minAgreement?.[n.interval] ?? 1))
  }, [feed, popupIntervals, minAgreement])

  // One beep / native notification per batch of newly arrived crossovers.
  useEffect(() => {
    const fresh = items.filter((e) => !announcedRef.current.has(e.id))
    if (fresh.length === 0) return
    fresh.forEach((e) => announcedRef.current.add(e.id))
    if (document.hidden) showBrowserNotification({ ...summarizeForBrowser(fresh), tag: 'crossover-alert' })
    playAlertBeep()
  }, [items])

  const dismiss = useCallback(() => {
    const ids = items.map((i) => i.id)
    dispatch(markNotificationsReadLocally(ids))
    // The read route accepts at most 1000 ids per request.
    for (let i = 0; i < ids.length; i += 500) {
      markNotificationsRead(ids.slice(i, i + 500)).catch((error) => console.error('Crossover alerts could not be marked read:', error))
    }
  }, [items, dispatch])

  const open = items.length > 0

  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event) => {
      if (event.key === 'Escape') dismiss()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, dismiss])

  const groups = useMemo(() => groupBySymbol(items), [items])
  const bullishCount = items.filter((i) => i.direction === 'bullish').length
  const bearishCount = items.length - bullishCount
  const latestBar = items.reduce((max, i) => Math.max(max, i.candleTimestamp || 0), 0)

  if (!open) return null

  const handleViewNotifications = () => {
    dismiss()
    onViewNotifications?.()
  }

  // Portaled to <body>: AppShell mounts this inside the header, whose
  // backdrop-filter makes it the containing block for `fixed` descendants -
  // without the portal the overlay is clipped to the 48px header strip.
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-md bg-black/60" onClick={dismiss}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="crossover-alert-title"
        className="glass-panel rounded-xl w-full max-w-2xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-md border-b border-outline-variant">
          <h2 id="crossover-alert-title" className="text-base font-semibold text-on-surface">
            {items.length} crossover{items.length === 1 ? '' : 's'} detected
            <span className="ml-sm text-[10px] font-medium uppercase text-primary align-middle">● live</span>
          </h2>
          <p className="text-xs text-on-surface-variant">
            <span className="text-bullish">▲ {bullishCount} bullish</span> · <span className="text-bearish">▼ {bearishCount} bearish</span> · {groups.length} symbol
            {groups.length === 1 ? '' : 's'} · latest bar {formatCandleTime(latestBar)} IST
          </p>
        </div>

        <div className="overflow-y-auto p-md flex flex-col gap-sm">
          {groups.map((group) => (
            <section key={group.key} className="rounded-lg bg-surface-container-low border border-outline-variant p-sm">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-on-surface">
                  {group.symbol} <span className="text-xs font-normal text-on-surface-variant">{group.exchange}</span>
                </span>
                <span className="text-xs text-on-surface-variant">
                  {group.bullish > 0 && <span className="text-bullish">▲ {group.bullish}</span>}
                  {group.bullish > 0 && group.bearish > 0 && ' · '}
                  {group.bearish > 0 && <span className="text-bearish">▼ {group.bearish}</span>}
                </span>
              </div>
              <ul className="mt-xs flex flex-col gap-xs">
                {group.items.map((item) => (
                  <li key={item.id} className="text-xs text-on-surface-variant border-t border-outline-variant pt-xs first:border-t-0 first:pt-0">
                    <div className="text-on-surface">
                      <span className="mr-xs px-[6px] py-[1px] rounded bg-surface-container-highest text-[10px] uppercase text-on-surface-variant">{item.timeframeLabel || timeframeLabel(item.interval)}</span>
                      {directionBadge(item.direction)} <span className="font-medium">{item.indicatorLabel}</span>
                    </div>
                    <div>
                      Bar {formatCandleTime(item.candleTimestamp)} IST · Close ₹{item.closePrice}
                    </div>
                    <div>{formatLines(item.lines)}</div>
                    {item.confluence?.length > 0 && <div>Also crossed: {item.confluence.join(', ')}</div>}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <div className="p-md border-t border-outline-variant flex justify-end gap-sm">
          <button type="button" onClick={handleViewNotifications} className="px-md py-sm rounded-lg text-sm text-on-surface-variant hover:text-on-surface">
            View notifications
          </button>
          <button type="button" autoFocus onClick={dismiss} className="px-md py-sm rounded-lg bg-primary-container text-on-primary-container text-sm font-medium">
            Dismiss all
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

export default CrossoverAlertPopup
