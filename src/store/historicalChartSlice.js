import { createSlice } from '@reduxjs/toolkit'
import { REHYDRATE } from 'redux-persist'

// Selection/config state only - never candle or indicator arrays (those
// stay in HistoricalChartTab's local state, ephemeral, refetched on load).
// startTime/endTime are datetime-local strings ('YYYY-MM-DDTHH:mm', IST-
// implied) mapping directly to Groww's own start_time/end_time params - left
// empty here (HistoricalChartTab fills in an interval-appropriate default on
// first mount) rather than baking in a "now"-relative default that would go
// stale the moment this persisted state is rehydrated from localStorage.
function buildInitialState() {
  return {
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
      supportResistance: { enabled: false, lookback: 5 },
      tsi: { enabled: false, longPeriod: 25, shortPeriod: 13, signalPeriod: 13 },
      stochRsi: { enabled: false, rsiPeriod: 14, stochasticPeriod: 14, kPeriod: 3, dPeriod: 3 },
      adx: { enabled: false, period: 14 },
      rsiDivergence: { enabled: false, rsiPeriod: 14, lookback: 5 },
    },
  }
}

// Factory instead of one static slice - the Chart tab is mounted twice (see
// App.jsx's 'chart'/'chart2' entries, both rendering HistoricalChartTab with
// a different instanceKey - src/store/index.js creates one slice instance
// per key via this factory) so each copy needs fully independent symbol/
// interval/date-range/indicator state rather than sharing one.
export function createHistoricalChartSlice(name) {
  return createSlice({
    name,
    initialState: buildInitialState(),
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
      // payload: { key: 'sma' | 'ema' | 'bollingerBands' | 'rsi' | 'macd' | 'supportResistance' | 'tsi' | 'stochRsi' | 'adx', changes: {...} }
      setIndicatorConfig(state, action) {
        const { key, changes } = action.payload
        state.indicatorConfig[key] = { ...state.indicatorConfig[key], ...changes }
      },
    },
    // redux-persist's default reconciler (store/index.js) only merges one
    // level into each whitelisted slice - for a nested field like
    // indicatorConfig, a persisted blob saved before an indicator was added
    // (e.g. before TSI/Stoch RSI/ADX existed here) wholesale-REPLACES the
    // fresh default indicatorConfig with the old, incomplete one, silently
    // dropping the new keys entirely - IndicatorControlRow then reads
    // `indicatorConfig.tsi.enabled` on `undefined` and crashes the whole
    // tab. Handling REHYDRATE here ourselves and deep-merging indicatorConfig
    // (new keys fall back to today's defaults, existing keys keep whatever
    // the user had persisted) fixes this now AND for any future indicator
    // added the same way - redux-persist's own documented escape hatch for
    // this exact class of bug (a slice reducer that handles REHYDRATE opts
    // that slice out of the reconciler's default whole-object replacement).
    extraReducers: (builder) => {
      builder.addCase(REHYDRATE, (state, action) => {
        const persisted = action.payload?.[name]
        if (!persisted) return state
        return { ...persisted, indicatorConfig: { ...buildInitialState().indicatorConfig, ...(persisted.indicatorConfig || {}) } }
      })
    },
  })
}
