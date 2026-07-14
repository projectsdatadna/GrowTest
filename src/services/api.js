import axios from 'axios'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5001'

const apiClient = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
})

// Get all instruments/symbols
export const getInstruments = async () => {
  try {
    const response = await apiClient.get('/instruments')
    return response.data
  } catch (error) {
    console.error('Error fetching instruments:', error)
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
