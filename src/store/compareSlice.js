import { createSlice } from '@reduxjs/toolkit'

const initialState = {
  selectedSymbol: '',
  snapshotAId: '',
  snapshotBId: '',
  result: null,
}

const compareSlice = createSlice({
  name: 'compare',
  initialState,
  reducers: {
    setSelectedSymbol(state, action) {
      state.selectedSymbol = action.payload
      state.snapshotAId = ''
      state.snapshotBId = ''
      state.result = null
    },
    setSnapshotAId(state, action) {
      state.snapshotAId = action.payload
    },
    setSnapshotBId(state, action) {
      state.snapshotBId = action.payload
    },
    setCompareResult(state, action) {
      state.result = action.payload
    },
    resetCompare() {
      return initialState
    },
  },
})

export const { setSelectedSymbol, setSnapshotAId, setSnapshotBId, setCompareResult, resetCompare } = compareSlice.actions
export default compareSlice.reducer
