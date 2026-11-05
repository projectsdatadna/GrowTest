import { createSlice } from '@reduxjs/toolkit'

// Server-owned data (Firestore, via the historicalWatchlistFetchTask/
// dispatch automation in functions/) - never persisted to localStorage, see
// store/index.js's persistConfig. Polled from AppShell (notifications) and
// from HistoricalChartTab (entries) the same way WatchlistTab already polls
// its own option-chain watchlist data.
const initialState = {
  entries: [],
  notifications: [],
  unreadCount: 0,
}

const historicalWatchlistSlice = createSlice({
  name: 'historicalWatchlist',
  initialState,
  reducers: {
    setHistoricalWatchlistEntries(state, action) {
      state.entries = action.payload
    },
    // The bell dropdown's latest notifications (every type). unreadCount is
    // NOT derived from this list - it is the server's exact count of all
    // unread notifications (setUnreadCount), since the list only holds the
    // latest few.
    setHistoricalWatchlistNotifications(state, action) {
      state.notifications = action.payload
    },
    setUnreadCount(state, action) {
      state.unreadCount = action.payload
    },
    // Optimistic local update so the badge/dropdown react immediately on
    // click rather than waiting for the next poll tick, which then
    // recalibrates the count from the server.
    markNotificationsReadLocally(state, action) {
      const ids = new Set(action.payload)
      state.notifications.forEach((n) => {
        if (ids.has(n.id)) n.read = true
      })
      state.unreadCount = Math.max(0, state.unreadCount - ids.size)
    },
  },
})

export const { setHistoricalWatchlistEntries, setHistoricalWatchlistNotifications, setUnreadCount, markNotificationsReadLocally } = historicalWatchlistSlice.actions
export default historicalWatchlistSlice.reducer
