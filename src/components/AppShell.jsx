import { useEffect, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { getHistoricalWatchlistNotifications, markHistoricalWatchlistNotificationRead, markAllHistoricalWatchlistNotificationsRead } from '../services/api'
import { setHistoricalWatchlistNotifications, markNotificationsReadLocally } from '../store/historicalWatchlistSlice'

/**
 * Dark "terminal" app shell (sidebar + top header) from the Stitch mockup.
 * Greek Analysis, Compare, Watchlist, and Chart are the real, functional nav
 * items - the avatar is still decorative/unlinked. The header notification
 * bell WAS decorative too (no handler, "Not available yet") - now wired to
 * the Historical Watchlist's notifications (see NotificationBell below).
 */
function ServerTimeClock() {
  const [now, setNow] = useState(new Date())

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  const time = now.toLocaleTimeString('en-US', { hour12: false })

  return (
    <div className="text-right">
      <p className="text-[10px] font-medium uppercase text-on-surface-variant">Local Time</p>
      <p className="text-on-surface font-mono text-sm">{time}</p>
    </div>
  )
}

const NOTIFICATIONS_POLL_MS = 45000

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

// Bell icon + unread badge + dropdown, backed by the Historical Watchlist's
// notifications (functions/historicalWatchlistFirestoreClient.js) - polled
// on an interval, same convention WatchlistTab already uses for its own
// polling rather than a live subscription.
function NotificationBell() {
  const dispatch = useDispatch()
  const notifications = useSelector((state) => state.historicalWatchlist.notifications)
  const unreadCount = useSelector((state) => state.historicalWatchlist.unreadCount)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const fetchNotifications = () => {
      getHistoricalWatchlistNotifications()
        .then(({ notifications: fetched }) => dispatch(setHistoricalWatchlistNotifications(fetched || [])))
        .catch((err) => console.error('Failed to load historical watchlist notifications:', err))
    }
    fetchNotifications()
    const id = setInterval(fetchNotifications, NOTIFICATIONS_POLL_MS)
    return () => clearInterval(id)
  }, [dispatch])

  const handleOpenNotification = (notification) => {
    if (notification.read) return
    dispatch(markNotificationsReadLocally([notification.id]))
    markHistoricalWatchlistNotificationRead(notification.id).catch((err) => console.error('Failed to mark notification read:', err))
  }

  const handleMarkAllRead = () => {
    dispatch(markNotificationsReadLocally(notifications.map((n) => n.id)))
    markAllHistoricalWatchlistNotificationsRead().catch((err) => console.error('Failed to mark all notifications read:', err))
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="relative material-symbols-outlined text-on-surface-variant hover:text-on-surface cursor-pointer"
        title="Historical Watchlist notifications"
      >
        notifications
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-[3px] rounded-full bg-error text-on-error text-[10px] font-bold flex items-center justify-center">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-[calc(100%+8px)] w-80 max-h-96 overflow-y-auto glass-panel rounded-xl p-sm z-50 flex flex-col gap-xs">
            <div className="flex items-center justify-between px-sm py-xs">
              <span className="text-xs font-medium text-on-surface-variant uppercase">Notifications</span>
              {unreadCount > 0 && (
                <button type="button" onClick={handleMarkAllRead} className="text-xs text-primary hover:underline">
                  Mark all read
                </button>
              )}
            </div>
            {notifications.length === 0 && <div className="text-xs text-on-surface-variant px-sm py-md text-center">No notifications yet.</div>}
            {notifications.map((n) => (
              <div
                key={n.id}
                onClick={() => handleOpenNotification(n)}
                className={`px-sm py-xs rounded-lg cursor-pointer text-sm ${n.read ? 'text-on-surface-variant' : 'text-on-surface bg-surface-container-highest'}`}
              >
                <div className="flex items-center justify-between gap-sm">
                  <span className="font-medium">
                    {n.symbol} · {n.interval}
                  </span>
                  <span className="text-[10px] text-on-surface-variant">{timeAgo(n.createdAt)}</span>
                </div>
                <div className="text-xs text-on-surface-variant">{n.newCandleCount} new candle{n.newCandleCount === 1 ? '' : 's'}</div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

const NAV_ITEMS = [
  { key: 'greek-analysis', label: 'Greek Analysis', icon: 'analytics', functional: true },
  { key: 'compare', label: 'Compare', icon: 'compare_arrows', functional: true },
  { key: 'watchlist', label: 'Watchlist', icon: 'visibility', functional: true },
  { key: 'chart', label: 'Chart', icon: 'candlestick_chart', functional: true },
  { key: 'chart2', label: 'Chart 2', icon: 'show_chart', functional: true },
]

function AppShell({ activeTab, onTabChange, children }) {
  return (
    <div className="min-h-screen bg-background text-on-background">
      <aside className="fixed left-0 top-0 h-full w-[250px] bg-surface-container-low border-r border-outline-variant flex flex-col p-md gap-base z-50">
        <div className="mb-xl px-sm">
          <h1 className="text-lg font-bold text-primary">ALPHA TERMINAL</h1>
          <p className="text-[11px] font-medium text-on-surface-variant uppercase tracking-widest">Trading Desk</p>
        </div>

        <nav className="flex-1 flex flex-col gap-xs">
          {NAV_ITEMS.map((item) => {
            const isActive = item.functional && activeTab === item.key
            return (
              <div
                key={item.key}
                onClick={item.functional ? () => onTabChange(item.key) : undefined}
                className={`flex items-center gap-md px-md py-sm rounded-lg transition-colors duration-150 ${
                  item.functional ? 'cursor-pointer active:scale-95' : 'cursor-default opacity-50'
                } ${
                  isActive
                    ? 'bg-primary-container text-on-primary-container'
                    : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container-highest'
                }`}
                title={item.functional ? undefined : 'Not available yet'}
              >
                <span className="material-symbols-outlined">{item.icon}</span>
                <span className="text-sm font-medium">{item.label}</span>
              </div>
            )
          })}
        </nav>
      </aside>

      <header className="sticky top-0 right-0 z-40 w-[calc(100%-250px)] ml-[250px] bg-surface/60 backdrop-blur-md border-b border-outline-variant flex justify-end items-center h-12 px-xl">
        <div className="flex items-center gap-md">
          <NotificationBell />
          <div
            className="w-8 h-8 rounded-full bg-primary-container text-on-primary-container flex items-center justify-center text-xs font-bold"
            title="Account"
          >
            U
          </div>
        </div>
      </header>

      <main className="ml-[250px] p-xl flex flex-col gap-lg">{children}</main>
    </div>
  )
}

export { ServerTimeClock }
export default AppShell
