import axios from 'axios'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5055'

const apiClient = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
})

// Persist the Groww access token pasted in from the Greek Analysis tab -
// every Groww-dependent route (including the unattended watchlistTick
// scheduler) reads this same stored value server-side.
export const saveGrowwAccessToken = async (access_token) => {
  try {
    const response = await apiClient.post('/groww-access-token', { access_token })
    return response.data
  } catch (error) {
    console.error('Error saving Groww access token:', error)
    throw error
  }
}

// Get the canonical underlying-symbol list for the searchable dropdown
export const getUnderlyingSymbols = async () => {
  try {
    const response = await apiClient.get('/underlying-symbols')
    return response.data
  } catch (error) {
    console.error('Error fetching underlying symbols:', error)
    throw error
  }
}

// Get current quote for a symbol
export const getCurrentQuote = async (symbol, exchange = 'NSE') => {
  try {
    const response = await apiClient.get('/quote', {
      params: {
        symbol,
        exchange,
      },
    })
    return response.data
  } catch (error) {
    console.error('Error fetching current quote:', error)
    throw error
  }
}

// Get option chain for a symbol
export const getOptionChain = async (underlying_symbol, exchange = 'NSE', expiry_date = null) => {
  try {
    const params = {
      underlying_symbol,
      exchange,
    }
    
    if (expiry_date) {
      params.expiry_date = expiry_date
    }
    
    const response = await apiClient.get('/option-chain', {
      params,
    })
    return response.data
  } catch (error) {
    console.error('Error fetching option chain:', error)
    throw error
  }
}

// Analyze option chain within a +/- points range, with full Greeks, via AI
export const analyzeOptionChainRange = async (data) => {
  try {
    const response = await apiClient.post('/analyze-option-chain-range', data)
    return response.data
  } catch (error) {
    console.error('Error analyzing option chain range:', error)
    throw error
  }
}

// Compare two Greek Analysis snapshots (e.g. latest vs ~15 min prior) for an AI trend inference
export const compareOptionChainSnapshots = async (previous, latest, promptType = 'master_prompt') => {
  try {
    const response = await apiClient.post('/compare-option-chain-snapshots', { previous, latest, prompt_type: promptType })
    return response.data
  } catch (error) {
    console.error('Error comparing option chain snapshots:', error)
    throw error
  }
}

// List saved option-chain analysis snapshots (lightweight metadata only), optionally filtered by underlying symbol
export const getOptionChainSnapshots = async (underlying_symbol, limit = 50) => {
  try {
    const response = await apiClient.get('/option-chain-snapshots', {
      params: { underlying_symbol, limit },
    })
    return response.data
  } catch (error) {
    console.error('Error fetching option chain snapshots:', error)
    throw error
  }
}

// Get one full saved snapshot by ID (for feeding into compareOptionChainSnapshots)
export const getOptionChainSnapshotById = async (id) => {
  try {
    const response = await apiClient.get(`/option-chain-snapshots/${id}`)
    return response.data
  } catch (error) {
    console.error('Error fetching option chain snapshot:', error)
    throw error
  }
}

// Regenerates a saved snapshot's AI analysis from its own filtered_strikes
// (no previous-snapshot context) and persists it back - used by the Compare
// tab to upgrade a legacy-schema snapshot to the full institutional report.
export const regenerateSnapshotAnalysis = async (id, promptType = 'master_prompt') => {
  try {
    const response = await apiClient.post(`/option-chain-snapshots/${id}/regenerate-analysis`, { prompt_type: promptType })
    return response.data
  } catch (error) {
    console.error('Error regenerating snapshot analysis:', error)
    throw error
  }
}

// Watchlist - server-driven tracking (see functions/watchlistScheduler.js).
// The background job only refreshes snapshot data - AI analysis is
// triggered on demand via generateWatchlistAnalysis below.
export const addWatchlistEntry = async ({ underlying_symbol, exchange, expiry_date, points_range }) => {
  try {
    const response = await apiClient.post('/watchlist', { underlying_symbol, exchange, expiry_date, points_range })
    return response.data
  } catch (error) {
    console.error('Error adding watchlist entry:', error)
    throw error
  }
}

export const getWatchlistEntries = async () => {
  try {
    const response = await apiClient.get('/watchlist')
    return response.data
  } catch (error) {
    console.error('Error fetching watchlist entries:', error)
    throw error
  }
}

export const removeWatchlistEntry = async (id) => {
  try {
    const response = await apiClient.delete(`/watchlist/${id}`)
    return response.data
  } catch (error) {
    console.error('Error removing watchlist entry:', error)
    throw error
  }
}

export const getLatestWatchlistAnalysis = async (watchlistId, tier) => {
  try {
    const response = await apiClient.get(`/watchlist/${watchlistId}/analysis/${tier}`)
    return response.data
  } catch (error) {
    console.error('Error fetching watchlist analysis:', error)
    throw error
  }
}

// Triggers a fresh AI comparison (current vs ~tier-minutes-ago snapshot) for
// one entry's tier - the only way this feature calls AI now that the
// background job is pure data-refresh. promptType is 'master_prompt' or
// 'summarized_recommendations'; only that one style is computed.
export const generateWatchlistAnalysis = async (watchlistId, tier, promptType) => {
  try {
    const response = await apiClient.post(`/watchlist/${watchlistId}/analysis/${tier}/generate`, { prompt_type: promptType })
    return response.data
  } catch (error) {
    console.error('Error generating watchlist analysis:', error)
    throw error
  }
}

// The automatic Difference-column comparison - refreshed by watchlistTick
// itself on this tier's own cadence, unlike the full report above which only
// updates on demand.
export const getWatchlistDifference = async (watchlistId, tier) => {
  try {
    const response = await apiClient.get(`/watchlist/${watchlistId}/difference/${tier}`)
    return response.data
  } catch (error) {
    console.error('Error fetching watchlist difference:', error)
    throw error
  }
}

// Get AI inference
export const getAIInference = async (data) => {
  try {
    const response = await apiClient.post('/ai/inference', data)
    return response.data
  } catch (error) {
    console.error('Error getting AI inference:', error)
    throw error
  }
}

// datetime-local inputs give 'YYYY-MM-DDTHH:mm' - Groww's own API (and this
// app's backend, which parses it as IST wall-clock time) wants
// 'YYYY-MM-DD HH:MM:SS'.
const toGrowwDateTimeParam = (datetimeLocalValue) => `${datetimeLocalValue.replace('T', ' ')}:00`

// Historical Chart - fetches (and, server-side, stores) OHLC candles for a
// symbol/exchange/interval/date-range on demand, matching Groww's own
// start_time/end_time contract directly (no invented "count" parameter).
// Backed by GET /historical-data, which checks Firestore first and only
// calls Groww for what's missing/stale.
export const getHistoricalCandles = async (symbol, { exchange = 'NSE', interval = '1day', startTime, endTime }) => {
  try {
    const response = await apiClient.get('/historical-data', {
      params: { symbol, exchange, interval, start_time: toGrowwDateTimeParam(startTime), end_time: toGrowwDateTimeParam(endTime) },
    })
    return response.data
  } catch (error) {
    console.error('Error fetching historical candles:', error)
    throw error
  }
}

// Fetches (and stores) one or more indicator series computed from the same
// stored candles. `indicators` is a comma-separated spec string, e.g.
// "SMA:20,EMA:50,BB:20:2,RSI:14,MACD:12:26:9".
export const getIndicatorSeries = async (symbol, { exchange = 'NSE', interval = '1day', startTime, endTime, indicators }) => {
  try {
    const response = await apiClient.get('/historical-data/indicators', {
      params: { symbol, exchange, interval, start_time: toGrowwDateTimeParam(startTime), end_time: toGrowwDateTimeParam(endTime), indicators },
    })
    return response.data
  } catch (error) {
    console.error('Error fetching indicator series:', error)
    throw error
  }
}

// On-demand AI insight over the historical candles/indicators for a range -
// reads the server's own Firestore-cached data for this range, never sends
// series data itself. `indicators` is the same comma-separated spec string
// getIndicatorSeries takes.
export const getHistoricalAiInsight = async (symbol, { exchange = 'NSE', interval = '1day', startTime, endTime, indicators }) => {
  try {
    const response = await apiClient.post('/historical-data/ai-insight', {
      symbol,
      exchange,
      interval,
      start_time: toGrowwDateTimeParam(startTime),
      end_time: toGrowwDateTimeParam(endTime),
      indicators,
    })
    return response.data
  } catch (error) {
    console.error('Error getting historical AI insight:', error)
    throw error
  }
}

// Historical Watchlist - tracks (symbol, exchange, interval) combinations
// for automated background refresh (see functions/historicalWatchlistScheduler.js).
// The background job (Cloud Tasks) only refreshes candle/indicator data -
// AI insight is triggered on demand via generateHistoricalWatchlistInsight
// below.
export const addHistoricalWatchlistEntry = async ({ symbol, exchange, interval, indicatorSpecs }) => {
  try {
    const response = await apiClient.post('/historical-watchlist', { symbol, exchange, interval, indicatorSpecs })
    return response.data
  } catch (error) {
    console.error('Error adding historical watchlist entry:', error)
    throw error
  }
}

export const getHistoricalWatchlistEntries = async () => {
  try {
    const response = await apiClient.get('/historical-watchlist')
    return response.data
  } catch (error) {
    console.error('Error fetching historical watchlist entries:', error)
    throw error
  }
}

export const removeHistoricalWatchlistEntry = async (id) => {
  try {
    const response = await apiClient.delete(`/historical-watchlist/${id}`)
    return response.data
  } catch (error) {
    console.error('Error removing historical watchlist entry:', error)
    throw error
  }
}

// Latest automated AI insight for one entry (or null if none has run yet) -
// computed server-side on the entry's own configured interval, same prompt
// the on-demand "AI Insight" button uses (getHistoricalAiInsight below).
export const getHistoricalWatchlistAnalysis = async (id) => {
  try {
    const response = await apiClient.get(`/historical-watchlist/${id}/analysis`)
    return response.data
  } catch (error) {
    console.error('Error fetching historical watchlist analysis:', error)
    throw error
  }
}

// Triggers a fresh AI insight for one Historical Watchlist entry - the only
// way this feature calls AI now that the background job is pure data-
// refresh. Persists, so a subsequent getHistoricalWatchlistAnalysis call
// picks up the fresh result.
export const generateHistoricalWatchlistInsight = async (id) => {
  try {
    const response = await apiClient.post(`/historical-watchlist/${id}/ai-insight`)
    return response.data
  } catch (error) {
    console.error('Error generating historical watchlist insight:', error)
    throw error
  }
}

export const getHistoricalWatchlistNotifications = async (unreadOnly = false) => {
  try {
    const response = await apiClient.get('/historical-watchlist/notifications', { params: { unreadOnly } })
    return response.data
  } catch (error) {
    console.error('Error fetching historical watchlist notifications:', error)
    throw error
  }
}

export const markHistoricalWatchlistNotificationRead = async (id) => {
  try {
    const response = await apiClient.post(`/historical-watchlist/notifications/${id}/read`)
    return response.data
  } catch (error) {
    console.error('Error marking historical watchlist notification read:', error)
    throw error
  }
}

export const markAllHistoricalWatchlistNotificationsRead = async () => {
  try {
    const response = await apiClient.post('/historical-watchlist/notifications/mark-all-read')
    return response.data
  } catch (error) {
    console.error('Error marking all historical watchlist notifications read:', error)
    throw error
  }
}

// Search NSE/BSE cash-equity instruments by symbol OR company name (see
// functions/instrumentMasterSync.js) - backs the Chart tab's symbol picker.
export const searchInstruments = async (query) => {
  try {
    const response = await apiClient.get('/instrument-search', { params: { q: query } })
    return response.data
  } catch (error) {
    console.error('Error searching instruments:', error)
    throw error
  }
}

export default apiClient
