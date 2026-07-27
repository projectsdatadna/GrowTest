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
// The client only ever manages the tracked-symbol list and reads back
// whatever the scheduler already computed - it never triggers analysis.
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

// Get historical data
export const getHistoricalData = async (symbol, params = {}) => {
  try {
    const response = await apiClient.get('/historical', {
      params: {
        symbol,
        ...params,
      },
    })
    return response.data
  } catch (error) {
    console.error('Error fetching historical data:', error)
    throw error
  }
}

export default apiClient
