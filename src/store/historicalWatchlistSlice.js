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
    setHistoricalWatchlistNotifications(state, action) {
      state.notifications = action.payload
      state.unreadCount = action.payload.filter((n) => !n.read).length
    },
    // Optimistic local update so the badge/dropdown react immediately on
    // click rather than waiting for the next poll tick.
    markNotificationsReadLocally(state, action) {
      const ids = new Set(action.payload)
      state.notifications.forEach((n) => {
        if (ids.has(n.id)) n.read = true
      })
      state.unreadCount = state.notifications.filter((n) => !n.read).length
    },
  },
})

export const { setHistoricalWatchlistEntries, setHistoricalWatchlistNotifications, markNotificationsReadLocally } = historicalWatchlistSlice.actions
export default historicalWatchlistSlice.reducer
