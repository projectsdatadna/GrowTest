import { configureStore, combineReducers } from '@reduxjs/toolkit'
import { persistStore, persistReducer, FLUSH, REHYDRATE, PAUSE, PERSIST, PURGE, REGISTER } from 'redux-persist'
import storage from 'redux-persist/lib/storage'
import greekAnalysisReducer from './greekAnalysisSlice'
import compareReducer from './compareSlice'
import watchlistReducer from './watchlistSlice'

const persistConfig = {
  key: 'growtest',
  storage,
  whitelist: ['greekAnalysis', 'compare', 'watchlist'],
}

const rootReducer = combineReducers({
  greekAnalysis: greekAnalysisReducer,
  compare: compareReducer,
  watchlist: watchlistReducer,
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
