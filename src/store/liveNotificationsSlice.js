import { createSlice } from '@reduxjs/toolkit'
import { markNotificationsReadLocally } from './historicalWatchlistSlice'
import { mergeFeedItems } from '../components/liveRefresh'

// The single live notification feed shared by the bell and the
// Notifications page (see useLiveNotifications). Server-owned and never
// persisted (store/index.js whitelist) - always rebuilt from the API on load.
const MAX_ITEMS = 3000

const initialState = {
  items: [], // newest first
  cursor: null, // createdAt (ISO) of the newest item seen - the next poll asks for anything after it
  loaded: false,
}

const byNewest = (a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || String(b.id).localeCompare(String(a.id))

const liveNotificationsSlice = createSlice({
  name: 'liveNotifications',
  initialState,
  reducers: {
    // Merge fetched items into the feed. An id already marked read locally
    // stays read (a poll in flight must not resurrect a dismissed alert).
    mergeNotifications(state, action) {
      const { items = [] } = action.payload
      // An unchanged poll leaves state.items untouched, so the Notifications tab
      // does not re-render every 5 s with nothing new.
      const merged = mergeFeedItems(state.items, items)
      if (merged.changed) state.items = merged.items.sort(byNewest).slice(0, MAX_ITEMS)
      const newest = items.reduce((max, n) => (n.createdAt && n.createdAt > max ? n.createdAt : max), state.cursor || '')
      state.cursor = newest || state.cursor
      state.loaded = true
    },
    // Starting point for the live feed when there is nothing stored yet.
    setCursorIfEmpty(state, action) {
      if (!state.cursor) state.cursor = action.payload
      state.loaded = true
    },
    // After a bulk delete: drop the feed items the server just deleted.
    removeNotificationsInRange(state, action) {
      const { sections, from, to } = action.payload
      const wanted = new Set(sections)
      const fromSec = Date.parse(from) / 1000
      const toSec = Date.parse(to) / 1000
      state.items = state.items.filter((n) => {
        const isSystem = n.type === 'scanner_warning'
        const section = isSystem ? 'system' : n.interval
        if (!wanted.has(section)) return true
        // Mirrors the server: crossovers by bar time, System warnings by createdAt.
        const inRange = isSystem ? n.createdAt >= from && n.createdAt <= to : n.candleTimestamp >= fromSec && n.candleTimestamp <= toSec
        return !inRange
      })
    },
    markAllReadLocally(state) {
      state.items.forEach((n) => {
        n.read = true
      })
    },
  },
  extraReducers: (builder) => {
    // Every existing "mark these ids read" dispatch (bell, tab) also
    // keeps this feed in sync.
    builder.addCase(markNotificationsReadLocally, (state, action) => {
      const ids = new Set(action.payload)
      state.items.forEach((n) => {
        if (ids.has(n.id)) n.read = true
      })
    })
  },
})

export const { mergeNotifications, setCursorIfEmpty, markAllReadLocally, removeNotificationsInRange } = liveNotificationsSlice.actions
export default liveNotificationsSlice.reducer
