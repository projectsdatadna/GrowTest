import { createSlice } from '@reduxjs/toolkit'

const initialState = {
  selectedSymbol: '',
  snapshotAId: '',
  snapshotBId: '',
  promptType: 'master_prompt',
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
    setPromptType(state, action) {
      state.promptType = action.payload
    },
    setCompareResult(state, action) {
      state.result = action.payload
    },
    resetCompare() {
      return initialState
    },
  },
})

export const { setSelectedSymbol, setSnapshotAId, setSnapshotBId, setPromptType, setCompareResult, resetCompare } = compareSlice.actions
export default compareSlice.reducer
