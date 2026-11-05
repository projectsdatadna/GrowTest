/**
 * Popup for the latest crossover alert. Mounted once in AppShell so it works
 * on every tab. It does no fetching of its own: it reads the shared live feed
 * (useLiveNotifications, polled every few seconds) and shows ONE crossover at
 * a time - the most recent by when it actually happened (the closing time of
 * the bar that crossed). When a newer crossover arrives it replaces the one on
 * screen, which is marked read (it was seen). Crossovers that were never shown
 * (several landed at once, or a backlog on load) are skipped by the popup but
 * stay unread in the bell and on the Notifications page; the popup says how
 * many.
 *
 * Dismiss marks the shown crossover read. New arrivals also beep, and fire a
 * native browser notification when the tab is hidden (if the user enabled it
 * from the Crossover Scanner tab).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDispatch, useSelector } from 'react-redux'
import { markNotificationsRead } from '../services/api'
import { markNotificationsReadLocally } from '../store/historicalWatchlistSlice'
import { crossoverTimestamp, formatCrossoverTime, formatLines, showBrowserNotification, playAlertBeep, timeframeLabel, TIMEFRAME_ORDER } from './crossoverFormat'

// Fallback until the server says which timeframes should pop up (the live feed
// returns popupIntervals). Mirrors the server default.
const DEFAULT_POPUP_INTERVALS = TIMEFRAME_ORDER

// Newest crossover first: by when it happened, then by when it was stored.
const byLatest = (a, b) => crossoverTimestamp(b) - crossoverTimestamp(a) || String(b.createdAt).localeCompare(String(a.createdAt))

function directionBadge(direction) {
  return direction === 'bullish' ? (
    <span className="text-bullish font-semibold">▲ Bullish</span>
  ) : (
    <span className="text-bearish font-semibold">▼ Bearish</span>
  )
}

function CrossoverAlertPopup({ onViewNotifications }) {
  const dispatch = useDispatch()
  const feed = useSelector((state) => state.liveNotifications.items)
  const popupIntervals = useSelector((state) => state.liveNotifications.popupIntervals)
  const minAgreement = useSelector((state) => state.liveNotifications.minAgreement)
  const [shownId, setShownId] = useState(null)
  // What the popup is currently showing, and ids it will never show (closed or
  // skipped). Refs: they gate effects and must not trigger renders themselves.
  const shownRef = useRef(null)
  const closedRef = useRef(new Set())

  // Unread crossovers on a popup timeframe with enough agreeing indicators,
  // newest first.
  const candidates = useMemo(() => {
    const popupSet = new Set(popupIntervals || DEFAULT_POPUP_INTERVALS)
    return feed.filter((n) => n.type === 'crossover' && !n.read && popupSet.has(n.interval) && (n.agreement ?? 1) >= (minAgreement?.[n.interval] ?? 1)).sort(byLatest)
  }, [feed, popupIntervals, minAgreement])

  const markRead = useCallback(
    (ids) => {
      if (ids.length === 0) return
      dispatch(markNotificationsReadLocally(ids))
      markNotificationsRead(ids).catch((error) => console.error('Crossover alert could not be marked read:', error))
    },
    [dispatch]
  )

  // Show the newest crossover; replace (and mark read) the previous one.
  useEffect(() => {
    const pool = candidates.filter((n) => !closedRef.current.has(n.id))
    if (pool.length === 0) return
    const [top, ...skipped] = pool
    skipped.forEach((n) => closedRef.current.add(n.id))
    if (top.id === shownRef.current) return

    const previousId = shownRef.current
    if (previousId) {
      closedRef.current.add(previousId)
      if (candidates.some((n) => n.id === previousId)) markRead([previousId])
    }
    shownRef.current = top.id
    setShownId(top.id)

    if (document.hidden) {
      showBrowserNotification({
        title: `${top.symbol} ${top.direction === 'bullish' ? '▲' : '▼'} ${top.indicatorLabel} · ${timeframeLabel(top.interval)}`,
        body: `Crossed ${formatCrossoverTime(top)} · Close ₹${top.closePrice}`,
        tag: 'crossover-alert',
      })
    }
    playAlertBeep()
  }, [candidates, markRead])

  const shown = shownId ? feed.find((n) => n.id === shownId) : null
  const open = Boolean(shown) && !shown.read
  const otherUnread = candidates.filter((n) => n.id !== shownId).length

  const dismiss = useCallback(() => {
    if (!shown) return
    closedRef.current.add(shown.id)
    markRead([shown.id])
  }, [shown, markRead])

  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event) => {
      if (event.key === 'Escape') dismiss()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, dismiss])

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
      <div role="dialog" aria-modal="true" aria-labelledby="crossover-alert-title" className="glass-panel rounded-xl w-full max-w-md flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="p-md border-b border-outline-variant">
          <h2 id="crossover-alert-title" className="text-base font-semibold text-on-surface">
            Latest crossover
            <span className="ml-sm text-[10px] font-medium uppercase text-primary align-middle">● live</span>
          </h2>
          <p className="text-xs text-on-surface-variant">Crossed {formatCrossoverTime(shown)}</p>
        </div>

        <div className="p-md flex flex-col gap-xs">
          <div className="flex items-center justify-between">
            <span className="text-lg font-semibold text-on-surface">
              {shown.symbol} <span className="text-xs font-normal text-on-surface-variant">{shown.exchange}</span>
            </span>
            <span className="px-[6px] py-[1px] rounded bg-surface-container-highest text-[10px] uppercase text-on-surface-variant">{shown.timeframeLabel || timeframeLabel(shown.interval)}</span>
          </div>
          <div className="text-sm text-on-surface">
            {directionBadge(shown.direction)} <span className="font-medium">{shown.indicatorLabel}</span>
          </div>
          <div className="text-xs text-on-surface-variant">Close ₹{shown.closePrice}</div>
          <div className="text-xs text-on-surface-variant">{formatLines(shown.lines)}</div>
          {shown.confluence?.length > 0 && <div className="text-xs text-on-surface-variant">Also crossed: {shown.confluence.join(', ')}</div>}
        </div>

        <div className="p-md border-t border-outline-variant flex items-center justify-between gap-sm">
          <span className="text-xs text-on-surface-variant">{otherUnread > 0 ? `+${otherUnread} other unread crossover${otherUnread === 1 ? '' : 's'}` : ''}</span>
          <div className="flex gap-sm">
            <button type="button" onClick={handleViewNotifications} className="px-md py-sm rounded-lg text-sm text-on-surface-variant hover:text-on-surface">
              View notifications
            </button>
            <button type="button" autoFocus onClick={dismiss} className="px-md py-sm rounded-lg bg-primary-container text-on-primary-container text-sm font-medium">
              Dismiss
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}

export default CrossoverAlertPopup
