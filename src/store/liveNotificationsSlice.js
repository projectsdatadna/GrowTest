import { createSlice } from '@reduxjs/toolkit'
import { markNotificationsReadLocally } from './historicalWatchlistSlice'

// The single live notification feed shared by the bell, the crossover popup and
// the Notifications page (see useLiveNotifications). Server-owned and never
// persisted (store/index.js whitelist) - always rebuilt from the API on load.
const MAX_ITEMS = 3000

const initialState = {
  items: [], // newest first
  cursor: null, // createdAt (ISO) of the newest item seen - the next poll asks for anything after it
  loaded: false,
  popupIntervals: null, // null until the server tells us
  minAgreement: {},
}

const byNewest = (a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || String(b.id).localeCompare(String(a.id))

const liveNotificationsSlice = createSlice({
  name: 'liveNotifications',
  initialState,
  reducers: {
    // Merge fetched items into the feed. An id already marked read locally
    // stays read (a poll in flight must not resurrect a dismissed alert).
    mergeNotifications(state, action) {
      const { items = [], popupIntervals, minAgreement } = action.payload
      const known = new Map(state.items.map((n) => [n.id, n]))
      for (const n of items) {
        const existing = known.get(n.id)
        known.set(n.id, existing?.read ? { ...n, read: true } : n)
      }
      state.items = [...known.values()].sort(byNewest).slice(0, MAX_ITEMS)
      const newest = items.reduce((max, n) => (n.createdAt && n.createdAt > max ? n.createdAt : max), state.cursor || '')
      state.cursor = newest || state.cursor
      state.loaded = true
      if (popupIntervals) state.popupIntervals = popupIntervals
      if (minAgreement) state.minAgreement = minAgreement
    },
    // Starting point for the live feed when there is nothing stored yet.
    setCursorIfEmpty(state, action) {
      if (!state.cursor) state.cursor = action.payload
      state.loaded = true
    },
    markAllReadLocally(state) {
      state.items.forEach((n) => {
        n.read = true
      })
    },
  },
  extraReducers: (builder) => {
    // Every existing "mark these ids read" dispatch (bell, popup, tab) also
    // keeps this feed in sync.
    builder.addCase(markNotificationsReadLocally, (state, action) => {
      const ids = new Set(action.payload)
      state.items.forEach((n) => {
        if (ids.has(n.id)) n.read = true
      })
    })
  },
})

export const { mergeNotifications, setCursorIfEmpty, markAllReadLocally } = liveNotificationsSlice.actions
export default liveNotificationsSlice.reducer
