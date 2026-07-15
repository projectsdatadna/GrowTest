import { createSlice } from '@reduxjs/toolkit'

const LTP_HISTORY_LIMIT = 20

const initialState = {
  formData: {
    exchange: 'NSE',
    underlying_symbol: '',
    trading_symbol: '',
    expiry_date: '',
    points_range: '500',
  },
  analysis: null,
  lastUpdated: null,
  previousAnalysis: null,
  previousUpdated: null,
  comparison: null,
  ltpHistory: [],
}

const greekAnalysisSlice = createSlice({
  name: 'greekAnalysis',
  initialState,
  reducers: {
    setFormData(state, action) {
      state.formData = { ...state.formData, ...action.payload }
    },
    // Rotates the current analysis into "previous" (if one exists) and
    // commits the new one as current - this is what makes the latest/previous
    // 15-minute zones work. Reading `state.analysis` here (rather than a ref
    // mirroring it) is safe because Redux state is always current at dispatch
    // time, unlike a value captured in a React closure.
    applyAnalysisResult(state, action) {
      const { data, now } = action.payload
      if (state.analysis) {
        state.previousAnalysis = state.analysis
        state.previousUpdated = state.lastUpdated
      }
      state.analysis = data
      state.lastUpdated = now

      const next = [...state.ltpHistory, { time: now, ltp: data.underlying_ltp }]
      state.ltpHistory = next.length > LTP_HISTORY_LIMIT ? next.slice(next.length - LTP_HISTORY_LIMIT) : next
    },
    setComparison(state, action) {
      state.comparison = action.payload
    },
  },
})

export const { setFormData, applyAnalysisResult, setComparison } = greekAnalysisSlice.actions
export default greekAnalysisSlice.reducer
