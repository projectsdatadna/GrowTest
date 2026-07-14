/**
 * Groww API Backend - Firebase Cloud Function (2nd gen)
 * Same Express app as the root server.js, adapted for Cloud Functions:
 * secrets come from Firebase Secret Manager instead of .env, and there's
 * no static file serving / app.listen (Hosting serves the frontend).
 */

import express from 'express'
import cors from 'cors'
import axios from 'axios'
import crypto from 'crypto'
import { readFileSync } from 'fs'
import { onRequest } from 'firebase-functions/v2/https'
import { defineSecret } from 'firebase-functions/params'

const GROWW_API_KEY_SECRET = defineSecret('GROWW_API_KEY')
const GROWW_API_SECRET_SECRET = defineSecret('GROWW_API_SECRET')
const CLAUDE_API_KEY_SECRET = defineSecret('CLAUDE_API_KEY')

const app = express()
app.use(cors())
app.use(express.json())

// Groww API Configuration
const GROWW_API_BASE_URL = 'https://api.groww.in/v1'
const GROWW_API_VERSION = '1.0'
const GROWW_TOKEN_URL = 'https://api.groww.in/v1/token/api/access'
const INSTRUMENTS_JSON_LOCAL = './instruments-sample.json'

// Claude API Configuration
const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages'
const CLAUDE_MODEL = 'claude-3-haiku-20240307'

// In-memory cache for the exchanged Groww access token (valid until ~6 AM IST daily)
let cachedToken = null

/**
 * Exchange GROWW_API_KEY/GROWW_API_SECRET for a real Groww access token,
 * caching it until it's close to expiry. Throws with Groww's actual error
 * body attached (as `growwError`) so callers can surface the real reason.
 */
async function getGrowwAccessToken() {
  if (cachedToken && new Date(cachedToken.expiry).getTime() - Date.now() > 60000) {
    return cachedToken.token
  }

  const timestamp = Math.floor(Date.now() / 1000).toString()
  const apiKey = GROWW_API_KEY_SECRET.value()
  const apiSecret = GROWW_API_SECRET_SECRET.value()
  const checksum = crypto.createHash('sha256').update(apiSecret + timestamp).digest('hex')

  try {
    const response = await axios.post(
      GROWW_TOKEN_URL,
      { key_type: 'approval', checksum, timestamp },
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    )

    cachedToken = { token: response.data.token, expiry: response.data.expiry }
    console.log(`Generated fresh Groww access token, valid until ${cachedToken.expiry}`)
    return cachedToken.token
  } catch (error) {
    console.error('Failed to generate Groww access token:', error.message)
    const wrapped = new Error(`Failed to generate Groww access token: ${error.message}`)
    wrapped.growwError = error.response?.data || null
    wrapped.statusCode = error.response?.status || 500
    throw wrapped
  }
}

/**
 * Fetch instruments list from local sample JSON (no caching)
 */
async function fetchInstrumentsJSON() {
  try {
    console.log(`Fetching instruments from local sample JSON: ${INSTRUMENTS_JSON_LOCAL}`)
    const jsonData = readFileSync(INSTRUMENTS_JSON_LOCAL, 'utf-8')
    const instruments = JSON.parse(jsonData)
    console.log(`Successfully fetched ${instruments.length} instruments from sample JSON`)
    return instruments
  } catch (error) {
    console.error('Error fetching instruments JSON:', error.message)
    return null
  }
}

/**
 * Call Claude with a prepared prompt and parse its JSON response.
 * Shared by endpoints that need option-chain AI inference.
 */
async function analyzeWithClaude(promptContent) {
  const claudeResponse = await axios.post(
    CLAUDE_API_URL,
    {
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content: promptContent }],
    },
    {
      headers: {
        'x-api-key': CLAUDE_API_KEY_SECRET.value(),
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      timeout: 30000,
    }
  )

  if (claudeResponse.status !== 200 || !claudeResponse.data.content || claudeResponse.data.content.length === 0) {
    throw new Error('Failed to get analysis from Claude API')
  }

  const analysisText = claudeResponse.data.content[0].text

  let parsedAnalysis = null
  let explanation = ''

  try {
    const jsonMatch = analysisText.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      parsedAnalysis = JSON.parse(jsonMatch[0])
      const jsonStartIndex = analysisText.indexOf('{')
      if (jsonStartIndex > 0) {
        explanation = analysisText.substring(0, jsonStartIndex).trim()
      }
    } else {
      explanation = analysisText
    }

    explanation = explanation
      .replace(/[\n\r\t]/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/[{}[\]"'`]/g, '')
      .trim()
  } catch (parseError) {
    console.error('Error parsing JSON:', parseError.message)
    explanation = analysisText
      .replace(/[\n\r\t]/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/[{}[\]"'`]/g, '')
      .trim()
  }

  return { parsed_analysis: parsedAnalysis, raw_text: explanation }
}

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Groww API Server is running' })
})

/**
 * Search for symbols from instruments JSON
 */
app.get('/search', async (req, res) => {
  try {
    const query = (req.query.q || '').trim()
    const intraday = req.query.intraday

    if (!query || query.length < 1) {
      return res.status(400).json({ error: 'Search query too short' })
    }

    let instruments = await fetchInstrumentsJSON()
    if (!instruments) {
      console.log('JSON fetch failed, returning empty results')
      return res.json([])
    }

    const queryLower = query.toLowerCase()
    let results = instruments.filter((i) => {
      const symbol = (i.trading_symbol || '').toLowerCase()
      const name = (i.name || '').toLowerCase()
      return symbol.includes(queryLower) || queryLower.includes(symbol) || name.includes(queryLower)
    })

    if (intraday !== undefined && intraday !== null && intraday !== '') {
      const intradayValue = intraday === '1' || intraday === 1 || intraday === true
      results = results.filter((i) => {
        const isIntraday = i.is_intraday === 1 || i.is_intraday === '1' || i.is_intraday === true
        return isIntraday === intradayValue
      })
    }

    results = results
      .sort((a, b) => {
        const aSymbol = (a.trading_symbol || '').toLowerCase()
        const bSymbol = (b.trading_symbol || '').toLowerCase()
        if (aSymbol === queryLower) return -1
        if (bSymbol === queryLower) return 1
        if (aSymbol.startsWith(queryLower) && !bSymbol.startsWith(queryLower)) return -1
        if (bSymbol.startsWith(queryLower) && !aSymbol.startsWith(queryLower)) return 1
        return 0
      })
      .slice(0, 50)

    console.log(`Search query: "${query}", intraday: ${intraday}, results: ${results.length}`)
    res.json(results)
  } catch (error) {
    console.error('Search error:', error.message)
    res.status(500).json({ error: error.message })
  }
})

/**
 * Get current quote for a symbol using Groww Live Data API
 */
app.get('/quote', async (req, res) => {
  try {
    const accessToken = await getGrowwAccessToken()

    const symbol = req.query.symbol
    const exchange = req.query.exchange || 'NSE'

    if (!symbol) {
      return res.status(400).json({ error: 'Missing symbol parameter' })
    }

    const headers = {
      'Authorization': `Bearer ${accessToken}`,
      'X-API-VERSION': GROWW_API_VERSION,
      'Accept': 'application/json',
    }

    const url = `${GROWW_API_BASE_URL}/live-data/quote`
    const params = { exchange, segment: 'CASH', trading_symbol: symbol }

    console.log(`Calling Groww Live Data API: ${url}`)
    const response = await axios.get(url, { headers, params, timeout: 10000 })

    if (response.status === 200) {
      return res.json(response.data)
    }
  } catch (error) {
    console.error('Error:', error.message)

    if (error.growwError) {
      return res.status(error.statusCode || 500).json({ error: error.message, groww_error: error.growwError })
    }

    if (error.response?.status === 401) {
      return res.status(401).json({ error: 'Unauthorized - Invalid or expired access token' })
    }

    res.status(error.response?.status || 500).json({
      error: error.message,
      status_code: error.response?.status,
    })
  }
})

/**
 * Get available expiry dates for a symbol
 */
app.get('/option-expiries', async (req, res) => {
  try {
    const accessToken = await getGrowwAccessToken()

    const symbol = req.query.symbol
    const exchange = req.query.exchange || 'NSE'

    if (!symbol) {
      return res.status(400).json({ error: 'Missing symbol parameter' })
    }

    const headers = {
      'Authorization': `Bearer ${accessToken}`,
      'X-API-VERSION': GROWW_API_VERSION,
      'Accept': 'application/json',
    }

    try {
      const url = `${GROWW_API_BASE_URL}/historical/expiries`
      const params = { exchange, underlying_symbol: symbol }
      const response = await axios.get(url, { headers, params, timeout: 10000 })
      if (response.status === 200) {
        return res.json(response.data)
      }
    } catch (error) {
      console.log(`Expiries API error: ${error.message}`)
    }

    const today = new Date()
    const daysUntilThursday = (3 - today.getDay() + 7) % 7 || 7
    const nextThursday = new Date(today)
    nextThursday.setDate(today.getDate() + daysUntilThursday)
    const defaultExpiry = nextThursday.toISOString().split('T')[0]

    res.json({ status: 'SUCCESS', expiry_dates: [defaultExpiry] })
  } catch (error) {
    console.error('Error:', error.message)
    res.status(500).json({ error: error.message })
  }
})

/**
 * Get option chain for a symbol using Groww REST API
 */
app.get('/option-chain', async (req, res) => {
  try {
    const accessToken = await getGrowwAccessToken()

    const underlying_symbol = req.query.underlying_symbol || req.query.symbol
    const exchange = req.query.exchange || 'NSE'
    let expiry_date = req.query.expiry_date

    if (!underlying_symbol) {
      return res.status(400).json({ error: 'Missing underlying_symbol or symbol parameter' })
    }

    if (!expiry_date) {
      const today = new Date()
      const daysUntilThursday = (3 - today.getDay() + 7) % 7 || 7
      const nextThursday = new Date(today)
      nextThursday.setDate(today.getDate() + daysUntilThursday)
      expiry_date = nextThursday.toISOString().split('T')[0]
    }

    const headers = {
      'Authorization': `Bearer ${accessToken}`,
      'X-API-VERSION': GROWW_API_VERSION,
      'Accept': 'application/json',
    }

    try {
      const url = `${GROWW_API_BASE_URL}/option-chain/exchange/${exchange}/underlying/${underlying_symbol}`
      const params = { expiry_date }
      const response = await axios.get(url, { headers, params, timeout: 30000 })
      if (response.status === 200) {
        return res.json(response.data)
      }
    } catch (error) {
      console.log(`Option Chain API error: ${error.message}`)

      if (error.response?.status === 401) {
        return res.status(401).json({
          error: 'Authentication failed - Token expired or invalid',
          message: 'Please provide a valid API token. Tokens expire daily at 6:00 AM IST.',
          status_code: 401,
        })
      }

      return res.status(error.response?.status || 500).json({
        error: `Groww API returned ${error.response?.status}`,
        status_code: error.response?.status,
        underlying_symbol,
        exchange,
        expiry_date,
      })
    }
  } catch (error) {
    console.error('Error:', error.message)
    res.status(500).json({ error: error.message })
  }
})

/**
 * Get historical data for a symbol using Groww REST API
 */
app.get('/historical', async (req, res) => {
  try {
    const accessToken = await getGrowwAccessToken()

    const symbol = req.query.symbol
    const exchange = req.query.exchange || 'NSE'
    const interval = req.query.interval || '1day'
    const count = parseInt(req.query.count) || 100

    if (!symbol) {
      return res.status(400).json({ error: 'Missing symbol parameter' })
    }

    const headers = {
      'Authorization': `Bearer ${accessToken}`,
      'X-API-VERSION': GROWW_API_VERSION,
      'Accept': 'application/json',
    }

    try {
      const url = `${GROWW_API_BASE_URL}/historical/candles`
      const params = { exchange, symbol, interval, count }
      const response = await axios.get(url, { headers, params, timeout: 10000 })
      if (response.status === 200) {
        return res.json(response.data)
      }
    } catch (error) {
      console.log(`Historical API error: ${error.message}`)
    }

    res.status(400).json({ error: `Unable to fetch historical data for ${symbol}.`, symbol, exchange })
  } catch (error) {
    console.error('Error:', error.message)
    res.status(500).json({ error: error.message })
  }
})

/**
 * Analyze option chain with AI inference (percentage-based range)
 */
app.post('/analyze-option-chain', async (req, res) => {
  try {
    const { symbol, underlying_symbol, trading_symbol, exchange, expiry_date, calculate_percentage } = req.body

    if (!symbol || !underlying_symbol || !trading_symbol || !exchange || !expiry_date || calculate_percentage === undefined) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['symbol', 'underlying_symbol', 'trading_symbol', 'exchange', 'expiry_date', 'calculate_percentage'],
        received: Object.keys(req.body),
      })
    }

    const accessToken = await getGrowwAccessToken()

    const headers = {
      'Authorization': `Bearer ${accessToken}`,
      'X-API-VERSION': GROWW_API_VERSION,
      'Accept': 'application/json',
    }

    let optionChainData
    try {
      const url = `${GROWW_API_BASE_URL}/option-chain/exchange/${exchange}/underlying/${underlying_symbol}`
      const params = { expiry_date }
      const response = await axios.get(url, { headers, params, timeout: 30000 })

      if (response.status !== 200) {
        return res.status(response.status).json({ error: 'Failed to fetch option chain data', status_code: response.status })
      }

      optionChainData = response.data.payload
    } catch (error) {
      console.error(`Option chain API error: ${error.message}`)
      return res.status(error.response?.status || 500).json({
        error: 'Failed to fetch option chain data',
        message: error.message,
        status_code: error.response?.status || 500,
      })
    }

    const underlying_ltp = optionChainData.underlying_ltp
    if (!underlying_ltp || !optionChainData.strikes) {
      return res.status(400).json({ error: 'Invalid option chain response - missing underlying_ltp or strikes' })
    }

    const percentage = parseFloat(calculate_percentage)
    const maximum_calculated_value = (underlying_ltp * (1 + percentage / 100)).toFixed(2)
    const minimum_calculated_value = (underlying_ltp * (1 - percentage / 100)).toFixed(2)

    const filteredStrikes = {}
    Object.entries(optionChainData.strikes).forEach(([strikePrice, strikeData]) => {
      const strike = parseFloat(strikePrice)
      if (strike >= parseFloat(minimum_calculated_value) && strike <= parseFloat(maximum_calculated_value)) {
        filteredStrikes[strikePrice] = strikeData
      }
    })

    if (!filteredStrikes[minimum_calculated_value]) {
      filteredStrikes[minimum_calculated_value] = {
        CE: { ltp: 0, open_interest: 0, greeks: { iv: 0 }, is_boundary: true },
        PE: { ltp: 0, open_interest: 0, greeks: { iv: 0 }, is_boundary: true },
      }
    }
    if (!filteredStrikes[maximum_calculated_value]) {
      filteredStrikes[maximum_calculated_value] = {
        CE: { ltp: 0, open_interest: 0, greeks: { iv: 0 }, is_boundary: true },
        PE: { ltp: 0, open_interest: 0, greeks: { iv: 0 }, is_boundary: true },
      }
    }

    const sortedFilteredStrikes = {}
    Object.keys(filteredStrikes)
      .map(parseFloat)
      .sort((a, b) => a - b)
      .forEach((strike) => {
        sortedFilteredStrikes[strike.toString()] = filteredStrikes[strike.toString()]
      })

    if (Object.keys(sortedFilteredStrikes).length === 0) {
      return res.status(400).json({
        error: 'No strikes found within the calculated range',
        calculated_range: { min: minimum_calculated_value, max: maximum_calculated_value },
      })
    }

    let aiAnalysis
    try {
      const strikeKeys = Object.keys(sortedFilteredStrikes).slice(0, 10)
      const optionsSummary = strikeKeys.map((strike) => {
        const strikeData = sortedFilteredStrikes[strike]
        return {
          strike,
          ce_ltp: strikeData.CE?.ltp || 0,
          ce_oi: strikeData.CE?.open_interest || 0,
          ce_iv: strikeData.CE?.greeks?.iv || 0,
          pe_ltp: strikeData.PE?.ltp || 0,
          pe_oi: strikeData.PE?.open_interest || 0,
          pe_iv: strikeData.PE?.greeks?.iv || 0,
        }
      })

      const promptContent = `Analyze the following option chain data for ${trading_symbol} (underlying LTP: ₹${underlying_ltp}, Expiry: ${expiry_date}) and provide trading insights and detail_analysis:

Option Chain Summary:
${JSON.stringify(optionsSummary, null, 2)}

Please provide:
1. Market sentiment (Bullish/Bearish/Neutral)
2. Key support and resistance levels based on option data
3. Recommended trading strategy
4. Risk assessment
5. Confidence level (0-100)
6. Detail Analysis

Format your response as JSON with keys: sentiment, support_level, resistance_level, strategy, risk_assessment, confidence, detail_analysis`

      const result = await analyzeWithClaude(promptContent)
      aiAnalysis = {
        status: 'SUCCESS',
        symbol: trading_symbol,
        underlying_symbol,
        underlying_ltp,
        expiry_date,
        exchange,
        filteredStrikes: sortedFilteredStrikes,
        calculated_range: { min: minimum_calculated_value, max: maximum_calculated_value },
        filtered_strikes_count: Object.keys(sortedFilteredStrikes).length,
        parsed_analysis: result.parsed_analysis,
        raw_text: result.raw_text,
      }
    } catch (error) {
      console.error('AI Inference Error:', error.message)
      return res.status(error.response?.status || 500).json({ error: 'Failed to call AI inference', message: error.message })
    }

    return res.json(aiAnalysis)
  } catch (error) {
    console.error('Error:', error.message)
    res.status(500).json({ error: error.message })
  }
})

/**
 * Analyze option chain within a fixed +/- points range around the underlying LTP,
 * with full Greeks (delta, gamma, theta, vega, rho, iv) sent to the AI model.
 */
app.post('/analyze-option-chain-range', async (req, res) => {
  try {
    const { symbol, underlying_symbol, trading_symbol, exchange, expiry_date, points_range } = req.body

    if (!symbol || !underlying_symbol || !trading_symbol || !exchange || !expiry_date) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['symbol', 'underlying_symbol', 'trading_symbol', 'exchange', 'expiry_date'],
        received: Object.keys(req.body),
      })
    }

    const accessToken = await getGrowwAccessToken()

    const range = parseFloat(points_range)
    const pointsRange = !isNaN(range) && range > 0 ? range : 500

    const headers = {
      'Authorization': `Bearer ${accessToken}`,
      'X-API-VERSION': GROWW_API_VERSION,
      'Accept': 'application/json',
    }

    let optionChainData
    try {
      const url = `${GROWW_API_BASE_URL}/option-chain/exchange/${exchange}/underlying/${underlying_symbol}`
      const params = { expiry_date }
      const response = await axios.get(url, { headers, params, timeout: 30000 })

      if (response.status !== 200) {
        return res.status(response.status).json({ error: 'Failed to fetch option chain data', status_code: response.status })
      }

      optionChainData = response.data.payload
    } catch (error) {
      console.error(`Option chain API error: ${error.message}`)
      return res.status(error.response?.status || 500).json({
        error: 'Failed to fetch option chain data',
        message: error.message,
        groww_error: error.response?.data || null,
        status_code: error.response?.status || 500,
      })
    }

    const underlying_ltp = optionChainData.underlying_ltp
    if (!underlying_ltp || !optionChainData.strikes) {
      return res.status(400).json({ error: 'Invalid option chain response - missing underlying_ltp or strikes' })
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
      return res.status(400).json({
        error: 'No strikes found within the calculated range',
        calculated_range: { min: minimum_calculated_value, max: maximum_calculated_value },
      })
    }

    let parsed_analysis
    let raw_text
    try {
      const optionsSummary = Object.entries(sortedFilteredStrikes).map(([strike, data]) => ({
        strike,
        ce_ltp: data.CE?.ltp || 0,
        ce_oi: data.CE?.open_interest || 0,
        ce_greeks: data.CE?.greeks || {},
        pe_ltp: data.PE?.ltp || 0,
        pe_oi: data.PE?.open_interest || 0,
        pe_greeks: data.PE?.greeks || {},
      }))

      const promptContent = `Analyze the following option chain data for ${trading_symbol} (underlying LTP: ₹${underlying_ltp}, Expiry: ${expiry_date}) and provide trading insights and detail_analysis:

Option Chain Summary (+/-${pointsRange} points around LTP, full Greeks per strike):
${JSON.stringify(optionsSummary, null, 2)}

Please provide:
1. Market sentiment (Bullish/Bearish/Neutral)
2. Key support and resistance levels based on option data
3. Recommended trading strategy
4. Risk assessment
5. Confidence level (0-100)
6. Detail Analysis

Format your response as JSON with keys: sentiment, support_level, resistance_level, strategy, risk_assessment, confidence, detail_analysis`

      const result = await analyzeWithClaude(promptContent)
      parsed_analysis = result.parsed_analysis
      raw_text = result.raw_text
    } catch (error) {
      console.error('AI Inference Error:', error.message)
      return res.status(error.response?.status || 500).json({ error: 'Failed to call AI inference', message: error.message })
    }

    return res.json({
      status: 'SUCCESS',
      symbol: trading_symbol,
      underlying_symbol,
      trading_symbol,
      underlying_ltp,
      expiry_date,
      exchange,
      points_range: pointsRange,
      calculated_range: { min: minimum_calculated_value, max: maximum_calculated_value },
      filtered_strikes: sortedFilteredStrikes,
      filtered_strikes_count: Object.keys(sortedFilteredStrikes).length,
      parsed_analysis,
      raw_text,
    })
  } catch (error) {
    console.error('Error:', error.message)
    res.status(error.statusCode || 500).json({ error: error.message, groww_error: error.growwError || null })
  }
})

/**
 * Get AI inference on market data using Claude API (option chain passed directly)
 */
app.post('/ai/inference', async (req, res) => {
  try {
    const { symbol, underlying_symbol, underlying_ltp, strikes, exchange, expiry_date } = req.body

    if (!symbol || !underlying_symbol || !underlying_ltp || !strikes || !exchange || !expiry_date) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['symbol', 'underlying_symbol', 'underlying_ltp', 'strikes', 'exchange', 'expiry_date'],
        received: Object.keys(req.body),
      })
    }

    const strikeKeys = Object.keys(strikes).slice(0, 10)
    const optionsSummary = strikeKeys.map((strike) => {
      const strikeData = strikes[strike]
      return {
        strike,
        ce_ltp: strikeData.CE?.ltp || 0,
        ce_oi: strikeData.CE?.open_interest || 0,
        ce_iv: strikeData.CE?.greeks?.iv || 0,
        pe_ltp: strikeData.PE?.ltp || 0,
        pe_oi: strikeData.PE?.open_interest || 0,
        pe_iv: strikeData.PE?.greeks?.iv || 0,
      }
    })

    const promptContent = `Analyze the following option chain data for ${symbol} (underlying LTP: ₹${underlying_ltp}, Expiry: ${expiry_date}) and provide trading insights and detail_analysis:

Option Chain Summary:
${JSON.stringify(optionsSummary, null, 2)}

Please provide:
1. Market sentiment (Bullish/Bearish/Neutral)
2. Key support and resistance levels based on option data
3. Recommended trading strategy
4. Risk assessment
5. Confidence level (0-100)
6. Explain your analysis in detail

Format your response as JSON with keys: sentiment, support_level, resistance_level, strategy, risk_assessment, confidence, detail_analysis`

    const result = await analyzeWithClaude(promptContent)

    return res.json({
      status: 'SUCCESS',
      symbol,
      underlying_symbol,
      underlying_ltp,
      expiry_date,
      exchange,
      parsed_analysis: result.parsed_analysis,
      raw_text: result.raw_text,
    })
  } catch (error) {
    console.error('AI Inference Error:', error.message)
    res.status(error.response?.status || 500).json({
      error: error.message,
      details: error.response?.data || 'Unknown error',
    })
  }
})

/**
 * 404 handler for unmatched API routes
 */
app.use((_, res) => {
  res.status(404).json({ error: 'Endpoint not found' })
})

export const api = onRequest(
  {
    secrets: [GROWW_API_KEY_SECRET, GROWW_API_SECRET_SECRET, CLAUDE_API_KEY_SECRET],
    timeoutSeconds: 60,
    memory: '256MiB',
  },
  app
)
