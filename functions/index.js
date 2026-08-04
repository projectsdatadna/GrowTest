/**
 * Groww API Backend - Firebase Cloud Function (2nd gen)
 * Same Express app as the root server.js, adapted for Cloud Functions:
 * secrets come from Firebase Secret Manager instead of .env, and there's
 * no static file serving / app.listen (Hosting serves the frontend).
 */

import express from 'express'
import cors from 'cors'
import axios from 'axios'
import { onRequest } from 'firebase-functions/v2/https'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import { defineSecret } from 'firebase-functions/params'
import { runWatchlistTick, runWatchlistCleanup, recordGrowwAuthFailure, isWithinMarketHours } from './watchlistScheduler.js'
import {
  getUnderlyingSymbols,
  saveOptionChainSnapshot,
  listOptionChainSnapshots,
  getOptionChainSnapshot,
  updateOptionChainSnapshotAnalysis,
  getStoredGrowwAccessToken,
  saveGrowwAccessToken,
} from './firestoreClient.js'
import {
  buildInstitutionalAnalysisPrompt,
  buildSummarizedRecommendationsPrompt,
  analyzeWithAI,
  isSameInstrument,
} from './aiAnalysisPrompt.js'
import { fetchFilteredOptionChain } from './growwOptionChain.js'
import {
  createWatchlistEntry,
  listActiveWatchlistEntries,
  deactivateWatchlistEntry,
  getLatestWatchlistAnalysis,
  getWatchlistEntry,
} from './watchlistFirestoreClient.js'

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

/**
 * Returns the Groww access token pasted in via the UI (Greek Analysis tab)
 * and persisted with POST /groww-access-token. Previously this exchanged
 * GROWW_API_KEY/GROWW_API_SECRET for a token automatically, but that
 * exchange started being rejected by Groww with a 403 on every attempt from
 * 2026-07-25 onward - every Groww-dependent route, including the unattended
 * watchlistTick scheduler, now reads this one stored value instead.
 */
async function getGrowwAccessToken() {
  const token = await getStoredGrowwAccessToken()
  if (!token) {
    const err = new Error('No Groww access token has been saved yet - paste one in from the Greek Analysis tab.')
    err.statusCode = 401
    throw err
  }
  return token
}

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Groww API Server is running' })
})

/**
 * Save the Groww access token pasted in from the Greek Analysis tab - every
 * Groww-dependent route (including the unattended watchlistTick scheduler)
 * reads this same stored value via getGrowwAccessToken() above.
 */
app.post('/groww-access-token', async (req, res) => {
  try {
    const { access_token } = req.body
    if (!access_token) {
      return res.status(400).json({ error: 'Missing access_token' })
    }
    await saveGrowwAccessToken(access_token)
    res.json({ status: 'SUCCESS' })
  } catch (error) {
    console.error('Error saving Groww access token:', error.message)
    res.status(500).json({ error: error.message })
  }
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

    let chain
    try {
      chain = await fetchFilteredOptionChain({ exchange, underlying_symbol, expiry_date, points_range, groww_token: accessToken })
    } catch (error) {
      console.error('Option chain fetch error:', error.message)
      return res.status(error.details?.status_code || 400).json(error.details || { error: error.message })
    }

    const { underlying_ltp, points_range: pointsRange, calculated_range, filtered_strikes: sortedFilteredStrikes, filtered_strikes_count } = chain

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
      calculated_range,
      filtered_strikes: sortedFilteredStrikes,
      filtered_strikes_count,
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
 * Watchlist CRUD - the tracked-symbol config list. Fetching/analyzing is
 * done entirely by the watchlistTick scheduled function; these routes just
 * manage the list and read back whatever the scheduler has already computed.
 */
app.post('/watchlist', async (req, res) => {
  try {
    const { underlying_symbol, exchange, expiry_date, points_range } = req.body
    if (!underlying_symbol || !exchange || !expiry_date || !points_range) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['underlying_symbol', 'exchange', 'expiry_date', 'points_range'],
        received: Object.keys(req.body),
      })
    }
    const id = await createWatchlistEntry({ underlying_symbol, exchange, expiry_date, points_range })
    res.json({ status: 'SUCCESS', id })
  } catch (error) {
    console.error('Error creating watchlist entry:', error.message)
    res.status(500).json({ error: error.message })
  }
})

app.get('/watchlist', async (req, res) => {
  try {
    const entries = await listActiveWatchlistEntries()
    res.json({ status: 'SUCCESS', entries })
  } catch (error) {
    console.error('Error listing watchlist entries:', error.message)
    res.status(500).json({ error: error.message })
  }
})

app.delete('/watchlist/:id', async (req, res) => {
  try {
    await deactivateWatchlistEntry(req.params.id)
    res.json({ status: 'SUCCESS' })
  } catch (error) {
    console.error('Error removing watchlist entry:', error.message)
    res.status(500).json({ error: error.message })
  }
})

/**
 * Latest computed analysis for one watchlist entry's tier (5m/15m/75m) -
 * the Watchlist tab polls this on that tier's own cadence; it never
 * triggers analysis itself, only reads what watchlistTick already saved.
 */
app.get('/watchlist/:id/analysis/:tier', async (req, res) => {
  try {
    const { id, tier } = req.params
    if (!['5m', '15m', '75m'].includes(tier)) {
      return res.status(400).json({ error: 'tier must be one of 5m, 15m, 75m' })
    }
    const [analysis, entry] = await Promise.all([getLatestWatchlistAnalysis(id, tier), getWatchlistEntry(id)])
    const response = { status: 'SUCCESS', analysis }
    // Only present when the last fetch attempt for this entry actually
    // failed - the real Groww error (or "no token saved"), not fabricated.
    if (entry?.last_fetch_error) {
      response.groww_error = entry.last_fetch_error
    }
    res.json(response)
  } catch (error) {
    console.error('Error fetching watchlist analysis:', error.message)
    res.status(500).json({ error: error.message })
  }
})

/**
 * 404 handler for unmatched API routes
 */
app.use((_, res) => {
  res.status(404).json({ error: 'Endpoint not found' })
})

/**
 * Named `growtestApi`, not `api`: dev-cogniglob is a shared project (it
 * already hosts its own unrelated `api` function and default Hosting site
 * for the Cogniglob site) - keep this name unique so a future deploy can
 * never collide with or overwrite what's already there. See
 * FIREBASE_DEPLOY.md for the incident this same collision caused on the
 * previous project (devgraders).
 */
export const growtestApi = onRequest(
  {
    secrets: [
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

/**
 * Watchlist tracking - runs every 5 minutes, unattended, independent of any
 * browser being open. Guards itself to 9:15-15:30 IST on trading weekdays
 * (see isWithinMarketHours) rather than trying to encode that window in the
 * cron expression itself, so it's simplest to just schedule "every 5
 * minutes" all day and let the function skip non-market-hours ticks.
 */
export const watchlistTick = onSchedule(
  {
    schedule: 'every 5 minutes',
    timeZone: 'Asia/Kolkata',
    timeoutSeconds: 540,
    memory: '512MiB',
    secrets: [
      AZURE_OPENAI_API_KEY_SECRET,
      AZURE_OPENAI_ENDPOINT_SECRET,
      AZURE_OPENAI_DEPLOYMENT_SECRET,
      AZURE_OPENAI_API_VERSION_SECRET,
    ],
  },
  async () => {
    // Gated here too (not just inside runWatchlistTick) so a missing/invalid
    // token doesn't get recorded as a fresh failure against every entry once
    // per 5-minute tick around the clock outside market hours.
    if (!isWithinMarketHours()) {
      return
    }

    let groww_token
    try {
      groww_token = await getGrowwAccessToken()
    } catch (error) {
      console.error('watchlistTick: failed to obtain Groww access token:', error.message)
      await recordGrowwAuthFailure(error)
      return
    }

    const result = await runWatchlistTick({ groww_token, azureConfig: getAzureConfig() })
    console.log('watchlistTick result:', JSON.stringify(result))
  }
)

/**
 * Daily cleanup - wipes the day's fetched snapshots/analyses (not the
 * watchlist config itself) shortly after close, so tracking starts fresh
 * the next trading day.
 */
export const watchlistCleanup = onSchedule(
  { schedule: '35 15 * * 1-5', timeZone: 'Asia/Kolkata', timeoutSeconds: 300 },
  async () => {
    const result = await runWatchlistCleanup()
    console.log('watchlistCleanup result:', JSON.stringify(result))
  }
)
