/**
 * Shared Groww option-chain fetch + strike-range filtering, used by both
 * /analyze-option-chain-range (server.js and functions/index.js) and the
 * watchlistTick scheduled function - previously duplicated inline in each
 * analyze route.
 */

import axios from 'axios'

const GROWW_API_BASE_URL = 'https://api.groww.in/v1'
const GROWW_API_VERSION = '1.0'

/**
 * Fetches one symbol's option chain from Groww and filters it down to
 * strikes within +/- points_range of the underlying LTP. Throws an Error
 * with a `.details` object (matching the JSON body every existing caller
 * already returns on failure) on any problem - missing option chain fields,
 * a Groww API error, or zero strikes in range.
 */
export async function fetchFilteredOptionChain({ exchange, underlying_symbol, expiry_date, points_range, groww_token }) {
  const range = parseFloat(points_range)
  const pointsRange = !isNaN(range) && range > 0 ? range : 500

  const headers = {
    Authorization: `Bearer ${groww_token}`,
    'X-API-VERSION': GROWW_API_VERSION,
    Accept: 'application/json',
  }

  let optionChainData
  try {
    const url = `${GROWW_API_BASE_URL}/option-chain/exchange/${exchange}/underlying/${underlying_symbol}`
    const response = await axios.get(url, { headers, params: { expiry_date }, timeout: 30000 })
    optionChainData = response.data.payload
  } catch (error) {
    const err = new Error('Failed to fetch option chain data')
    err.details = {
      error: 'Failed to fetch option chain data',
      message: error.message,
      groww_error: error.response?.data || null,
      status_code: error.response?.status || 500,
    }
    throw err
  }

  const underlying_ltp = optionChainData.underlying_ltp
  if (!underlying_ltp || !optionChainData.strikes) {
    const err = new Error('Invalid option chain response - missing underlying_ltp or strikes')
    err.details = { error: 'Invalid option chain response - missing underlying_ltp or strikes' }
    throw err
  }

  const minimum_calculated_value = (underlying_ltp - pointsRange).toFixed(2)
  const maximum_calculated_value = (underlying_ltp + pointsRange).toFixed(2)

  const filteredStrikes = {}
  Object.entries(optionChainData.strikes).forEach(([strikePrice, strikeData]) => {
    const strike = parseFloat(strikePrice)
    if (strike >= parseFloat(minimum_calculated_value) && strike <= parseFloat(maximum_calculated_value)) {
      filteredStrikes[strikePrice] = strikeData
    }
  })

  const sortedFilteredStrikes = {}
  Object.keys(filteredStrikes)
    .map(parseFloat)
    .sort((a, b) => a - b)
    .forEach((strike) => {
      sortedFilteredStrikes[strike.toString()] = filteredStrikes[strike.toString()]
    })

  if (Object.keys(sortedFilteredStrikes).length === 0) {
    const err = new Error('No strikes found within the calculated range')
    err.details = {
      error: 'No strikes found within the calculated range',
      calculated_range: { min: minimum_calculated_value, max: maximum_calculated_value },
    }
    throw err
  }

  return {
    underlying_ltp,
    points_range: pointsRange,
    calculated_range: { min: minimum_calculated_value, max: maximum_calculated_value },
    filtered_strikes: sortedFilteredStrikes,
    filtered_strikes_count: Object.keys(sortedFilteredStrikes).length,
  }
}
