import { createSlice } from '@reduxjs/toolkit'

const initialState = {
  entries: [],
  selectedSymbol: '',
  selectedTier: '5m',
}

const watchlistSlice = createSlice({
  name: 'watchlist',
  initialState,
  reducers: {
    setWatchlistEntries(state, action) {
      state.entries = action.payload
      // Keep a valid selection once entries load - default to the first
      // symbol if nothing (or a since-removed symbol) is selected.
      const symbols = [...new Set(state.entries.map((e) => e.underlying_symbol))]
      if (!symbols.includes(state.selectedSymbol)) {
        state.selectedSymbol = symbols[0] || ''
      }
    },
    setSelectedSymbol(state, action) {
      state.selectedSymbol = action.payload
    },
    setSelectedTier(state, action) {
      state.selectedTier = action.payload
    },
  },
})

export const { setWatchlistEntries, setSelectedSymbol, setSelectedTier } = watchlistSlice.actions
export default watchlistSlice.reducer
