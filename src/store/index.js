import { configureStore, combineReducers } from '@reduxjs/toolkit'
import { persistStore, persistReducer, FLUSH, REHYDRATE, PAUSE, PERSIST, PURGE, REGISTER } from 'redux-persist'
import storage from 'redux-persist/lib/storage'
import greekAnalysisReducer from './greekAnalysisSlice'
import compareReducer from './compareSlice'
import watchlistReducer from './watchlistSlice'
import historicalChartReducer from './historicalChartSlice'

const persistConfig = {
  key: 'growtest',
  storage,
  // historicalChart holds only small selection/config fields (symbol,
  // exchange, interval, indicator params) - never candle/indicator arrays,
  // same as the other three slices - so whitelisting it in full is safe.
  whitelist: ['greekAnalysis', 'compare', 'watchlist', 'historicalChart'],
}

const rootReducer = combineReducers({
  greekAnalysis: greekAnalysisReducer,
  compare: compareReducer,
  watchlist: watchlistReducer,
  historicalChart: historicalChartReducer,
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
