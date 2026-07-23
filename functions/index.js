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
import { onRequest } from 'firebase-functions/v2/https'
import { defineSecret } from 'firebase-functions/params'
import {
  getUnderlyingSymbols,
  saveOptionChainSnapshot,
  listOptionChainSnapshots,
  getOptionChainSnapshot,
  updateOptionChainSnapshotAnalysis,
} from './firestoreClient.js'
import {
  buildInstitutionalAnalysisPrompt,
  buildSummarizedRecommendationsPrompt,
  analyzeWithAI,
  isSameInstrument,
} from './aiAnalysisPrompt.js'

const GROWW_API_KEY_SECRET = defineSecret('GROWW_API_KEY')
const GROWW_API_SECRET_SECRET = defineSecret('GROWW_API_SECRET')
const AZURE_OPENAI_API_KEY_SECRET = defineSecret('AZURE_OPENAI_API_KEY')
const AZURE_OPENAI_ENDPOINT_SECRET = defineSecret('AZURE_OPENAI_ENDPOINT')
const AZURE_OPENAI_DEPLOYMENT_SECRET = defineSecret('AZURE_OPENAI_DEPLOYMENT')
const AZURE_OPENAI_API_VERSION_SECRET = defineSecret('AZURE_OPENAI_API_VERSION')

function getAzureConfig() {
  return {
    apiKey: AZURE_OPENAI_API_KEY_SECRET.value(),
    endpoint: AZURE_OPENAI_ENDPOINT_SECRET.value(),
    deployment: AZURE_OPENAI_DEPLOYMENT_SECRET.value(),
    apiVersion: AZURE_OPENAI_API_VERSION_SECRET.value() || '2024-10-21',
  }
}

const app = express()
app.use(cors())
app.use(express.json({ limit: '5mb' }))

// Groww API Configuration
const GROWW_API_BASE_URL = 'https://api.groww.in/v1'
const GROWW_API_VERSION = '1.0'
const GROWW_TOKEN_URL = 'https://api.groww.in/v1/token/api/access'

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
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Groww API Server is running' })
})

/**
 * Get the canonical underlying-symbol list (from Firestore) for the
 * searchable dropdown in Greek Analysis
 */
app.get('/underlying-symbols', async (req, res) => {
  try {
    const symbols = await getUnderlyingSymbols()
    res.json({ symbols })
  } catch (error) {
    console.error('Underlying symbols fetch error:', error.message)
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

      const result = await analyzeWithAI(promptContent, getAzureConfig())
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
    const { symbol, underlying_symbol, exchange, expiry_date, points_range, groww_token, previous_snapshot, prompt_type } = req.body

    if (!symbol || !underlying_symbol || !exchange || !expiry_date) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['symbol', 'underlying_symbol', 'exchange', 'expiry_date'],
        received: Object.keys(req.body),
      })
    }

    const accessToken = groww_token || (await getGrowwAccessToken())

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
      const current = {
        underlying_symbol,
        underlying_ltp,
        expiry_date,
        exchange,
        points_range: pointsRange,
        filtered_strikes: sortedFilteredStrikes,
      }
      const previous =
        previous_snapshot && isSameInstrument(current, previous_snapshot) ? previous_snapshot : null

      const promptContent =
        prompt_type === 'summarized_recommendations'
          ? buildSummarizedRecommendationsPrompt(current, previous)
          : buildInstitutionalAnalysisPrompt(current, previous)

      const result = await analyzeWithAI(promptContent, getAzureConfig())
      parsed_analysis = result.parsed_analysis
      raw_text = result.raw_text
    } catch (error) {
      console.error('AI Inference Error:', error.message)
      return res.status(error.response?.status || 500).json({ error: 'Failed to call AI inference', message: error.message })
    }

    const result = {
      status: 'SUCCESS',
      symbol: underlying_symbol,
      underlying_symbol,
      underlying_ltp,
      expiry_date,
      exchange,
      points_range: pointsRange,
      calculated_range: { min: minimum_calculated_value, max: maximum_calculated_value },
      filtered_strikes: sortedFilteredStrikes,
      filtered_strikes_count: Object.keys(sortedFilteredStrikes).length,
      prompt_type: prompt_type === 'summarized_recommendations' ? 'summarized_recommendations' : 'master_prompt',
      parsed_analysis,
      raw_text,
    }

    try {
      await saveOptionChainSnapshot(result)
    } catch (error) {
      console.error('Failed to save option chain snapshot:', error.message)
    }

    return res.json(result)
  } catch (error) {
    console.error('Error:', error.message)
    res.status(error.statusCode || 500).json({ error: error.message, groww_error: error.growwError || null })
  }
})

/**
 * Get AI inference on market data using Azure OpenAI (option chain passed directly)
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

    const result = await analyzeWithAI(promptContent, getAzureConfig())

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
 * Compare two option-chain analysis snapshots (e.g. latest vs. ~5 min prior, or less if manually refreshed)
 * and get an AI-generated trend inference: what changed and what it means.
 */
app.post('/compare-option-chain-snapshots', async (req, res) => {
  try {
    const { previous, latest, prompt_type } = req.body

    if (!previous || !latest) {
      return res.status(400).json({
        error: 'Both previous and latest snapshots are required',
        required: ['previous', 'latest'],
        received: Object.keys(req.body),
      })
    }

    const promptContent =
      prompt_type === 'summarized_recommendations'
        ? buildSummarizedRecommendationsPrompt(latest, previous)
        : buildInstitutionalAnalysisPrompt(latest, previous)

    const result = await analyzeWithAI(promptContent, getAzureConfig())

    return res.json({
      status: 'SUCCESS',
      parsed_comparison: result.parsed_analysis,
      raw_text: result.raw_text,
    })
  } catch (error) {
    console.error('Comparison Error:', error.message)
    res.status(error.response?.status || 500).json({ error: error.message })
  }
})

/**
 * List saved option-chain analysis snapshots, optionally filtered by
 * underlying symbol - powers the Compare tab's snapshot pickers.
 */
app.get('/option-chain-snapshots', async (req, res) => {
  try {
    const { underlying_symbol, limit } = req.query
    const snapshots = await listOptionChainSnapshots(underlying_symbol || null, limit ? parseInt(limit) : 50)
    res.json({ status: 'SUCCESS', snapshots })
  } catch (error) {
    console.error('Error listing option chain snapshots:', error.message)
    res.status(500).json({ error: error.message })
  }
})

/**
 * Fetch one full saved snapshot by ID - used to feed the Compare tab's
 * analyze step (compareOptionChainSnapshots/computeGreeksDelta).
 */
app.get('/option-chain-snapshots/:id', async (req, res) => {
  try {
    const snapshot = await getOptionChainSnapshot(req.params.id)
    if (!snapshot) {
      return res.status(404).json({ error: 'Snapshot not found' })
    }
    res.json({ status: 'SUCCESS', snapshot })
  } catch (error) {
    console.error('Error fetching option chain snapshot:', error.message)
    res.status(500).json({ error: error.message })
  }
})

/**
 * Regenerates one existing snapshot's AI analysis from its own saved
 * filtered_strikes (no previous-snapshot context) and persists it back -
 * used by the Compare tab to upgrade a legacy-schema snapshot to the full
 * institutional report on demand, permanently replacing whatever was there.
 */
app.post('/option-chain-snapshots/:id/regenerate-analysis', async (req, res) => {
  try {
    const snapshot = await getOptionChainSnapshot(req.params.id)
    if (!snapshot) {
      return res.status(404).json({ error: 'Snapshot not found' })
    }

    const resolvedPromptType = req.body.prompt_type === 'summarized_recommendations' ? 'summarized_recommendations' : 'master_prompt'
    const promptContent =
      resolvedPromptType === 'summarized_recommendations'
        ? buildSummarizedRecommendationsPrompt(snapshot)
        : buildInstitutionalAnalysisPrompt(snapshot, null)
    const { parsed_analysis, raw_text } = await analyzeWithAI(promptContent, getAzureConfig())
    await updateOptionChainSnapshotAnalysis(req.params.id, { parsed_analysis, raw_text, prompt_type: resolvedPromptType })
    res.json({ status: 'SUCCESS', snapshot: { ...snapshot, parsed_analysis, raw_text, prompt_type: resolvedPromptType } })
  } catch (error) {
    console.error('Regenerate Analysis Error:', error.message)
    res.status(error.response?.status || 500).json({ error: error.message })
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
    secrets: [
      GROWW_API_KEY_SECRET,
      GROWW_API_SECRET_SECRET,
      AZURE_OPENAI_API_KEY_SECRET,
      AZURE_OPENAI_ENDPOINT_SECRET,
      AZURE_OPENAI_DEPLOYMENT_SECRET,
      AZURE_OPENAI_API_VERSION_SECRET,
    ],
    timeoutSeconds: 120,
    memory: '256MiB',
  },
  app
)
