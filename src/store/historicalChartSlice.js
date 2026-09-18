import { createSlice } from '@reduxjs/toolkit'

// Selection/config state only - never candle or indicator arrays (those
// stay in HistoricalChartTab's local state, ephemeral, refetched on load).
// startTime/endTime are datetime-local strings ('YYYY-MM-DDTHH:mm', IST-
// implied) mapping directly to Groww's own start_time/end_time params - left
// empty here (HistoricalChartTab fills in an interval-appropriate default on
// first mount) rather than baking in a "now"-relative default that would go
// stale the moment this persisted state is rehydrated from localStorage.
const initialState = {
  selectedSymbol: '',
  exchange: 'NSE',
  interval: '1day',
  startTime: '',
  endTime: '',
  indicatorConfig: {
    sma: { enabled: false, period: 20 },
    ema: { enabled: false, period: 20 },
    bollingerBands: { enabled: false, period: 20, stdDev: 2 },
    rsi: { enabled: false, period: 14 },
    macd: { enabled: false, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
  },
}

const historicalChartSlice = createSlice({
  name: 'historicalChart',
  initialState,
  reducers: {
    setSelectedSymbol(state, action) {
      state.selectedSymbol = action.payload
    },
    setExchange(state, action) {
      state.exchange = action.payload
    },
    setInterval(state, action) {
      state.interval = action.payload
    },
    setStartTime(state, action) {
      state.startTime = action.payload
    },
    setEndTime(state, action) {
      state.endTime = action.payload
    },
    // payload: { key: 'sma' | 'ema' | 'bollingerBands' | 'rsi' | 'macd', changes: {...} }
    setIndicatorConfig(state, action) {
      const { key, changes } = action.payload
      state.indicatorConfig[key] = { ...state.indicatorConfig[key], ...changes }
    },
  },
})

export const { setSelectedSymbol, setExchange, setInterval, setStartTime, setEndTime, setIndicatorConfig } = historicalChartSlice.actions
export default historicalChartSlice.reducer
