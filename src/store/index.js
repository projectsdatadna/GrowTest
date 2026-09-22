import { configureStore, combineReducers } from '@reduxjs/toolkit'
import { persistStore, persistReducer, FLUSH, REHYDRATE, PAUSE, PERSIST, PURGE, REGISTER } from 'redux-persist'
import storage from 'redux-persist/lib/storage'
import greekAnalysisReducer from './greekAnalysisSlice'
import compareReducer from './compareSlice'
import watchlistReducer from './watchlistSlice'
import { createHistoricalChartSlice } from './historicalChartSlice'
import historicalWatchlistReducer from './historicalWatchlistSlice'

// Two independent instances - one per Chart tab (see App.jsx's 'chart' and
// 'chart2' entries) - so each tab keeps its own symbol/exchange/interval/
// date-range/indicator config instead of sharing one.
export const historicalChartPrimarySlice = createHistoricalChartSlice('historicalChartPrimary')
export const historicalChartSecondarySlice = createHistoricalChartSlice('historicalChartSecondary')

const persistConfig = {
  key: 'growtest',
  storage,
  // historicalChartPrimary/Secondary hold only small selection/config fields
  // (symbol, exchange, interval, indicator params) - never candle/indicator
  // arrays, same as the other three slices - so whitelisting them in full is
  // safe. historicalWatchlist is intentionally NOT whitelisted - its entries
  // and notifications are server-owned (Firestore), refetched on load rather
  // than persisted to localStorage, so a stale local copy never disagrees
  // with what the backend actually has.
  whitelist: ['greekAnalysis', 'compare', 'watchlist', 'historicalChartPrimary', 'historicalChartSecondary'],
}

const rootReducer = combineReducers({
  greekAnalysis: greekAnalysisReducer,
  compare: compareReducer,
  watchlist: watchlistReducer,
  historicalChartPrimary: historicalChartPrimarySlice.reducer,
  historicalChartSecondary: historicalChartSecondarySlice.reducer,
  historicalWatchlist: historicalWatchlistReducer,
})

const persistedReducer = persistReducer(persistConfig, rootReducer)

export const store = configureStore({
  reducer: persistedReducer,
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: {
        ignoredActions: [FLUSH, REHYDRATE, PAUSE, PERSIST, PURGE, REGISTER],
      },
    }),
})

export const persistor = persistStore(store)
