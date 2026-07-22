import { createSlice } from '@reduxjs/toolkit'
import { isSameInstrument } from '../components/marketPulseEngine'

const LTP_HISTORY_LIMIT = 20

const initialState = {
  formData: {
    exchange: 'NSE',
    underlying_symbol: '',
    expiry_date: '',
    points_range: '500',
    prompt_type: 'master_prompt',
  },
  // Sticky Groww access token, entered once from the UI - a credential, not
  // a per-search form param, so it's kept separate from formData and left
  // untouched by resetAll below.
  growToken: '',
  analysis: null,
  lastUpdated: null,
  previousAnalysis: null,
  previousUpdated: null,
  ltpHistory: [],
}

const greekAnalysisSlice = createSlice({
  name: 'greekAnalysis',
  initialState,
  reducers: {
    setFormData(state, action) {
      state.formData = { ...state.formData, ...action.payload }
    },
    setGrowToken(state, action) {
      state.growToken = action.payload
    },
    // Rotates the current analysis into "previous" (if one exists) and
    // commits the new one as current - this is what makes the latest/previous
    // refresh-cycle zones work. Reading `state.analysis` here (rather than a
    // ref mirroring it) is safe because Redux state is always current at
    // dispatch time, unlike a value captured in a React closure.
    applyAnalysisResult(state, action) {
      const { data, now } = action.payload
      const sameInstrument = state.analysis && isSameInstrument(state.analysis, data)

      if (sameInstrument) {
        state.previousAnalysis = state.analysis
        state.previousUpdated = state.lastUpdated
      } else {
        // Underlying symbol/expiry/exchange changed since the last run
        // (without clicking Clear) - comparing across two different
        // instruments is meaningless, so start fresh instead of carrying
        // forward stale cross-instrument state.
        state.previousAnalysis = null
        state.previousUpdated = null
        state.ltpHistory = []
      }

      state.analysis = data
      state.lastUpdated = now

      const next = [...state.ltpHistory, { time: now, ltp: data.underlying_ltp }]
      state.ltpHistory = next.length > LTP_HISTORY_LIMIT ? next.slice(next.length - LTP_HISTORY_LIMIT) : next
    },
    // Full reset for the "Clear" button - wipes the form back to defaults
    // and drops every persisted snapshot/comparison.
    resetAll(state) {
      state.formData = { ...initialState.formData }
      state.analysis = null
      state.lastUpdated = null
      state.previousAnalysis = null
      state.previousUpdated = null
      state.ltpHistory = []
    },
  },
})

export const { setFormData, setGrowToken, applyAnalysisResult, resetAll } = greekAnalysisSlice.actions
export default greekAnalysisSlice.reducer
