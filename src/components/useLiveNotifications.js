/**
 * Keeps the shared live notification feed (store/liveNotificationsSlice) up to
 * date. Mounted ONCE in AppShell so the bell, the crossover popup and the
 * Notifications page all read the same data and never disagree.
 *
 *  - initial load of the latest notifications, then
 *  - a light incremental poll every LIVE_POLL_MS that only fetches what is new
 *    (GET /notifications/since) - so a crossover written by the scanner shows
 *    up within a few seconds, mid-scan - and
 *  - a slower full resync so read-state changed elsewhere is picked up.
 */

import { useEffect } from 'react'
import { useDispatch, useStore } from 'react-redux'
import { getNotifications, getNotificationsSince, getUnreadNotificationCount } from '../services/api'
import { setUnreadCount } from '../store/historicalWatchlistSlice'
import { mergeNotifications, setCursorIfEmpty } from '../store/liveNotificationsSlice'

const LIVE_POLL_MS = 5000
const MAX_BACKOFF_MS = 30000
const RESYNC_MS = 60000
const INITIAL_LIMIT = 500

export default function useLiveNotifications() {
  const dispatch = useDispatch()
  const store = useStore()

  useEffect(() => {
    let stopped = false
    let timer = null
    let failures = 0
    let polling = false

    const refreshUnreadCount = () =>
      getUnreadNotificationCount()
        .then(({ count }) => dispatch(setUnreadCount(count || 0)))
        .catch((error) => console.error('Failed to load unread count:', error))

    const fullLoad = async () => {
      const { notifications } = await getNotifications(INITIAL_LIMIT)
      dispatch(mergeNotifications({ items: notifications || [] }))
      // Nothing stored yet: start the live feed from a minute ago.
      dispatch(setCursorIfEmpty(new Date(Date.now() - 60000).toISOString()))
      refreshUnreadCount()
    }

    const poll = async () => {
      if (polling || stopped) return
      polling = true
      try {
        const live = store.getState().liveNotifications
        if (!live.loaded) {
          await fullLoad()
        } else {
          // Drain: keep asking while the server says there is more.
          for (let page = 0; page < 20; page++) {
            const cursor = store.getState().liveNotifications.cursor
            const data = await getNotificationsSince(cursor)
            const items = data.notifications || []
            // Overlap re-sends known items; only a genuinely new id changes the badge.
            const known = new Set(store.getState().liveNotifications.items.map((n) => n.id))
            const fresh = items.filter((n) => !known.has(n.id))
            dispatch(mergeNotifications({ items }))
            if (fresh.length > 0) refreshUnreadCount()
            if (!data.hasMore) break
          }
        }
        failures = 0
      } catch (error) {
        failures += 1
        console.error('Live notifications poll failed:', error)
      } finally {
        polling = false
      }
    }

    const schedule = () => {
      if (stopped) return
      const delay = failures === 0 ? LIVE_POLL_MS : Math.min(LIVE_POLL_MS * 2 ** failures, MAX_BACKOFF_MS)
      timer = setTimeout(async () => {
        await poll()
        schedule()
      }, delay)
    }

    const onVisible = () => {
      if (!document.hidden) poll()
    }

    poll().then(schedule)
    const resync = setInterval(() => fullLoad().catch((error) => console.error('Notification resync failed:', error)), RESYNC_MS)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      stopped = true
      clearTimeout(timer)
      clearInterval(resync)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [dispatch, store])
}
