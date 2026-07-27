import { createSlice } from '@reduxjs/toolkit'

const initialState = {
  formData: {
    exchange: 'NSE',
    underlying_symbol: '',
    expiry_date: '',
    points_range: '500',
  },
  // Sticky Groww access token, entered once from the UI - a credential, not
  // a per-search form param, so it's kept separate from formData and left
  // untouched by resetAll below. Saved server-side via POST
  // /groww-access-token (see GreekAnalysis.jsx's Save button) rather than
  // read from here at request time - every Groww-dependent route reads that
  // stored value directly.
  growToken: '',
  // Left over from before the Watchlist feature existed - no longer set by
  // anything, kept only so the Clear button can still wipe out any analysis
  // persisted by an older version of this page.
  analysis: null,
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
    // Full reset for the "Clear" button - wipes the form back to defaults
    // and drops any analysis persisted by an older version of this page.
    resetAll(state) {
      state.formData = { ...initialState.formData }
      state.analysis = null
    },
  },
})

export const { setFormData, setGrowToken, resetAll } = greekAnalysisSlice.actions
export default greekAnalysisSlice.reducer
