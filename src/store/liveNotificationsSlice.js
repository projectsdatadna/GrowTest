import { createSlice } from '@reduxjs/toolkit'
import { markNotificationsReadLocally } from './historicalWatchlistSlice'

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
      const known = new Map(state.items.map((n) => [n.id, n]))
      for (const n of items) {
        const existing = known.get(n.id)
        known.set(n.id, existing?.read ? { ...n, read: true } : n)
      }
      state.items = [...known.values()].sort(byNewest).slice(0, MAX_ITEMS)
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
