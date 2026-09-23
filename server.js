/**
 * Groww API Backend Server - Node.js/Express Version
 * Handles authentication and proxies requests to Groww REST API
 */

import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import axios from 'axios'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  getUnderlyingSymbols,
  saveOptionChainSnapshot,
  listOptionChainSnapshots,
  getOptionChainSnapshot,
  updateOptionChainSnapshotAnalysis,
  getStoredGrowwAccessToken,
  saveGrowwAccessToken,
} from './functions/firestoreClient.js'
import {
  buildInstitutionalAnalysisPrompt,
  buildSummarizedRecommendationsPrompt,
  analyzeWithAI,
  isSameInstrument,
} from './functions/aiAnalysisPrompt.js'
import { logAiUsage } from './functions/aiUsageFirestoreClient.js'
import { fetchFilteredOptionChain } from './functions/growwOptionChain.js'
import {
  createWatchlistEntry,
  listActiveWatchlistEntries,
  deactivateWatchlistEntry,
  getLatestWatchlistAnalysis,
  getWatchlistEntry,
} from './functions/watchlistFirestoreClient.js'
import { ensureCandlesFresh, parseIstDateTime } from './functions/growwHistoricalData.js'
import { ensureIndicatorFresh } from './functions/technicalIndicators.js'
import { buildHistoricalInsightPrompt } from './functions/historicalAiInsight.js'
import {
  createHistoricalWatchlistEntry,
  listActiveHistoricalWatchlistEntries,
  getHistoricalWatchlistEntry,
  deactivateHistoricalWatchlistEntry,
  listHistoricalWatchlistNotifications,
  markHistoricalWatchlistNotificationRead,
  markAllHistoricalWatchlistNotificationsRead,
} from './functions/historicalWatchlistFirestoreClient.js'
import { processDueEntry } from './functions/historicalWatchlistScheduler.js'
import { syncInstrumentMaster, searchInstruments } from './functions/instrumentMasterSync.js'

dotenv.config()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
app.use(cors())
app.use(express.json({ limit: '5mb' }))

// Serve static files from dist folder (built React app)
app.use(express.static(path.join(__dirname, 'dist')))

// Groww API Configuration
const GROWW_API_BASE_URL = 'https://api.groww.in/v1'
const GROWW_API_VERSION = '1.0'

// Azure OpenAI Configuration
const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY
const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT // e.g. https://<resource-name>.openai.azure.com
const AZURE_OPENAI_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT // the deployment name you chose, not the base model name
const AZURE_OPENAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '2024-10-21'

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
    const params = {
      exchange,
      segment: 'CASH',
      trading_symbol: symbol,
    }

    console.log(`Calling Groww Live Data API: ${url}`)
    console.log(`Params:`, params)

    const response = await axios.get(url, { headers, params, timeout: 10000 })

    console.log(`Response Status: ${response.status}`)

    if (response.status === 200) {
      console.log('Success! Got data from Groww API')
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
      const params = {
        exchange,
        underlying_symbol: symbol,
      }

      console.log(`Calling Groww Expiries API: ${url}`)
      console.log(`Params:`, params)

      const response = await axios.get(url, { headers, params, timeout: 10000 })

      console.log(`Expiries API Response: ${response.status}`)

      if (response.status === 200) {
        return res.json(response.data)
      }
    } catch (error) {
      console.log(`Expiries API error: ${error.message}`)
    }

    // Return default expiry date (next Thursday)
    const today = new Date()
    const daysUntilThursday = (3 - today.getDay() + 7) % 7 || 7
    const nextThursday = new Date(today)
    nextThursday.setDate(today.getDate() + daysUntilThursday)
    const defaultExpiry = nextThursday.toISOString().split('T')[0]

    res.json({
      status: 'SUCCESS',
      expiry_dates: [defaultExpiry],
    })
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

    // Accept both 'symbol' and 'underlying_symbol' for flexibility
    const underlying_symbol = req.query.underlying_symbol || req.query.symbol
    const exchange = req.query.exchange || 'NSE'
    let expiry_date = req.query.expiry_date

    if (!underlying_symbol) {
      return res.status(400).json({ error: 'Missing underlying_symbol or symbol parameter' })
    }

    // If no expiry_date provided, use next Thursday
    if (!expiry_date) {
      const today = new Date()
      const daysUntilThursday = (3 - today.getDay() + 7) % 7 || 7
      const nextThursday = new Date(today)
      nextThursday.setDate(today.getDate() + daysUntilThursday)
      expiry_date = nextThursday.toISOString().split('T')[0]
      console.log(`No expiry_date provided, using default: ${expiry_date}`)
    }

    const headers = {
      'Authorization': `Bearer ${accessToken}`,
      'X-API-VERSION': GROWW_API_VERSION,
      'Accept': 'application/json',
    }

    try {
      const url = `${GROWW_API_BASE_URL}/option-chain/exchange/${exchange}/underlying/${underlying_symbol}`
      const params = {
        expiry_date: expiry_date,
      }

      console.log(`Calling Groww Option Chain API: ${url}`)
      console.log(`Params:`, params)
      console.log(`Exchange: ${exchange}, Underlying: ${underlying_symbol}, Expiry: ${expiry_date}`)

      console.log(url,'url')

      const response = await axios.get(url, { headers, params, timeout: 30000 })

      console.log(`Option Chain API Response: ${response.status}`)

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
        expiry_date: expiry_date,
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
      const params = {
        exchange,
        symbol,
        interval,
        count,
      }

      const response = await axios.get(url, { headers, params, timeout: 10000 })

      console.log(`Historical API Response: ${response.status}`)

      if (response.status === 200) {
        return res.json(response.data)
      }
    } catch (error) {
      console.log(`Historical API error: ${error.message}`)
    }

    res.status(400).json({
      error: `Unable to fetch historical data for ${symbol}.`,
      symbol,
      exchange,
    })
  } catch (error) {
    console.error('Error:', error.message)
    res.status(500).json({ error: error.message })
  }
})

/**
 * Analyze option chain with AI inference
 * This endpoint gets option chain data, filters by calculated range, and calls AI inference
 */
app.post('/analyze-option-chain', async (req, res) => {
  try {
    const { symbol, underlying_symbol, trading_symbol, exchange, expiry_date, calculate_percentage } = req.body

    // Validate required fields
    if (!symbol || !underlying_symbol || !trading_symbol || !exchange || !expiry_date || calculate_percentage === undefined) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['symbol', 'underlying_symbol', 'trading_symbol', 'exchange', 'expiry_date', 'calculate_percentage'],
        received: Object.keys(req.body),
      })
    }

    const accessToken = await getGrowwAccessToken()

    console.log(`Analyzing option chain for ${underlying_symbol}...`)

    // Step 1: Fetch option chain data
    const headers = {
      'Authorization': `Bearer ${accessToken}`,
      'X-API-VERSION': GROWW_API_VERSION,
      'Accept': 'application/json',
    }

    let optionChainData
    try {
      const url = `${GROWW_API_BASE_URL}/option-chain/exchange/${exchange}/underlying/${underlying_symbol}`
      const params = { expiry_date }

      console.log(`Fetching option chain from Groww API...`)
      const response = await axios.get(url, { headers, params, timeout: 30000 })

      console.log(response,'response')

      if (response.status !== 200) {
        return res.status(response.status).json({
          error: 'Failed to fetch option chain data',
          status_code: response.status,
        })
      }

      optionChainData = response.data.payload
      console.log(`Option chain data received`)
    } catch (error) {
      console.error(`Option chain API error: ${error.message}`)
      return res.status(error.response?.status || 500).json({
        error: 'Failed to fetch option chain data',
        message: error.message,
        status_code: error.response?.status || 500,
      })
    }

    console.log(optionChainData,'optionChainData')

    // Step 2: Extract underlying_ltp and validate
    const underlying_ltp = optionChainData.underlying_ltp
    if (!underlying_ltp || !optionChainData.strikes) {
      return res.status(400).json({
        error: 'Invalid option chain response - missing underlying_ltp or strikes',
      })
    }

    console.log(`Underlying LTP: ${underlying_ltp}`)

    // Step 3: Calculate range based on percentage
    const percentage = parseFloat(calculate_percentage)
    const maximum_calculated_value = (underlying_ltp * (1 + percentage / 100)).toFixed(2)
    const minimum_calculated_value = (underlying_ltp * (1 - percentage / 100)).toFixed(2)

    console.log(`Calculated Range - Min: ${minimum_calculated_value}, Max: ${maximum_calculated_value}`)

    // Step 4: Filter strikes by calculated range
    const filteredStrikes = {}
    Object.entries(optionChainData.strikes).forEach(([strikePrice, strikeData]) => {
      const strike = parseFloat(strikePrice)
      if (strike >= parseFloat(minimum_calculated_value) && strike <= parseFloat(maximum_calculated_value)) {
        filteredStrikes[strikePrice] = strikeData
      }
    })

    // Add boundary strikes at minimum and maximum calculated values if they don't exist
    const minValue = parseFloat(minimum_calculated_value)
    const maxValue = parseFloat(maximum_calculated_value)

    // Check if minimum value strike exists, if not add a placeholder
    if (!filteredStrikes[minimum_calculated_value]) {
      filteredStrikes[minimum_calculated_value] = {
        CE: { ltp: 0, open_interest: 0, greeks: { iv: 0 }, is_boundary: true },
        PE: { ltp: 0, open_interest: 0, greeks: { iv: 0 }, is_boundary: true },
      }
    }

    // Check if maximum value strike exists, if not add a placeholder
    if (!filteredStrikes[maximum_calculated_value]) {
      filteredStrikes[maximum_calculated_value] = {
        CE: { ltp: 0, open_interest: 0, greeks: { iv: 0 }, is_boundary: true },
        PE: { ltp: 0, open_interest: 0, greeks: { iv: 0 }, is_boundary: true },
      }
    }

    // Sort strikes by price
    const sortedFilteredStrikes = {}
    Object.keys(filteredStrikes)
      .map(parseFloat)
      .sort((a, b) => a - b)
      .forEach(strike => {
        sortedFilteredStrikes[strike.toString()] = filteredStrikes[strike.toString()]
      })

    if (Object.keys(sortedFilteredStrikes).length === 0) {
      return res.status(400).json({
        error: 'No strikes found within the calculated range',
        calculated_range: {
          min: minimum_calculated_value,
          max: maximum_calculated_value,
        },
      })
    }

    console.log(`Filtered ${Object.keys(sortedFilteredStrikes).length} strikes within range`)

    // Step 5: Call AI inference internally
    let aiAnalysis
    try {
      if (!AZURE_OPENAI_API_KEY || !AZURE_OPENAI_ENDPOINT || !AZURE_OPENAI_DEPLOYMENT) {
        return res.status(500).json({ error: 'Azure OpenAI is not configured' })
      }

      // Prepare option chain summary for the AI model
      const strikeKeys = Object.keys(sortedFilteredStrikes).slice(0, 10)
      const optionsSummary = strikeKeys.map(strike => {
        const strikeData = sortedFilteredStrikes[strike]
        return {
          strike: strike,
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

      const azureResponse = await axios.post(
        `${AZURE_OPENAI_ENDPOINT.replace(/\/+$/, '')}/openai/deployments/${AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=${AZURE_OPENAI_API_VERSION}`,
        {
          messages: [
            {
              role: 'user',
              content: promptContent,
            },
          ],
          max_tokens: 1024,
        },
        {
          headers: {
            'api-key': AZURE_OPENAI_API_KEY,
            'content-type': 'application/json',
          },
          timeout: 30000,
        }
      )

      if (azureResponse.status === 200 && azureResponse.data.choices && azureResponse.data.choices.length > 0) {
        const analysisText = azureResponse.data.choices[0].message.content
        console.log('AI analysis received')
        // This route predates analyzeWithAI (functions/aiAnalysisPrompt.js)
        // and was never refactored to use it - calls Azure directly, so
        // usage is logged directly from this raw response too rather than
        // via that shared helper.
        logAiUsage({ feature: 'analyze_option_chain', usage: azureResponse.data.usage, model: AZURE_OPENAI_DEPLOYMENT, metadata: { trading_symbol, underlying_symbol, exchange, expiry_date } })

        // Parse JSON from response
        let parsedAnalysis = null
        let explanation = ''

        try {
          const jsonMatch = analysisText.match(/\{[\s\S]*\}/)
          if (jsonMatch) {
            parsedAnalysis = JSON.parse(jsonMatch[0])
            console.log('Successfully parsed analysis')

            const jsonStartIndex = analysisText.indexOf('{')
            if (jsonStartIndex > 0) {
              explanation = analysisText.substring(0, jsonStartIndex).trim()
            }
          } else {
            explanation = analysisText
          }

          // Clean explanation
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

        aiAnalysis = {
          status: 'SUCCESS',
          symbol: trading_symbol,
          underlying_symbol,
          underlying_ltp,
          expiry_date,
          exchange,
          filteredStrikes: sortedFilteredStrikes,
          calculated_range: {
            min: minimum_calculated_value,
            max: maximum_calculated_value,
          },
          filtered_strikes_count: Object.keys(sortedFilteredStrikes).length,
          parsed_analysis: parsedAnalysis,
          raw_text: explanation,
        }
      } else {
        return res.status(500).json({
          error: 'Failed to get analysis from Azure OpenAI',
        })
      }
    } catch (error) {
      console.error('AI Inference Error:', error.message)
      return res.status(error.response?.status || 500).json({
        error: 'Failed to call AI inference',
        message: error.message,
      })
    }

    // Step 6: Return AI analysis to UI
    console.log('Returning AI analysis to UI')
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

    console.log(`Analyzing option chain range for ${underlying_symbol}...`)

    let chain
    try {
      chain = await fetchFilteredOptionChain({ exchange, underlying_symbol, expiry_date, points_range, groww_token: accessToken })
    } catch (error) {
      console.error('Option chain fetch error:', error.message)
      return res.status(error.details?.status_code || 400).json(error.details || { error: error.message })
    }

    const { underlying_ltp, points_range: pointsRange, calculated_range, filtered_strikes: sortedFilteredStrikes, filtered_strikes_count } = chain

    console.log(`Filtered ${filtered_strikes_count} strikes within range`)

    // Step 5: Call AI inference with full Greeks for all filtered strikes
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

      const result = await analyzeWithAI(promptContent, {
        apiKey: AZURE_OPENAI_API_KEY,
        endpoint: AZURE_OPENAI_ENDPOINT,
        deployment: AZURE_OPENAI_DEPLOYMENT,
        apiVersion: AZURE_OPENAI_API_VERSION,
      })
      parsed_analysis = result.parsed_analysis
      raw_text = result.raw_text
      logAiUsage({ feature: 'analyze_option_chain_range', usage: result.usage, model: AZURE_OPENAI_DEPLOYMENT, metadata: { underlying_symbol, exchange, expiry_date, prompt_type } })
    } catch (error) {
      console.error('AI Inference Error:', error.message)
      return res.status(error.response?.status || 500).json({
        error: 'Failed to call AI inference',
        message: error.message,
      })
    }

    // Step 6: Return result to UI
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

    // Step 7: Persist every run so it's browsable/comparable later from the
    // Compare tab - a storage hiccup here must never fail the response the
    // user is actively waiting on.
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
 * Get AI inference on market data using Azure OpenAI
 */
app.post('/ai/inference', async (req, res) => {
  try {
    console.log(req.body,'req.body')

    const { symbol, underlying_symbol, underlying_ltp, strikes, exchange, expiry_date } = req.body

    // Validate required fields
    if (!symbol || !underlying_symbol || !underlying_ltp || !strikes || !exchange || !expiry_date) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['symbol', 'underlying_symbol', 'underlying_ltp', 'strikes', 'exchange', 'expiry_date'],
        received: Object.keys(req.body),
      })
    }

    if (!AZURE_OPENAI_API_KEY || !AZURE_OPENAI_ENDPOINT || !AZURE_OPENAI_DEPLOYMENT) {
      return res.status(500).json({ error: 'Azure OpenAI is not configured' })
    }

    // Prepare option chain summary for the AI model
    const strikeKeys = Object.keys(strikes).slice(0, 10) // Analyze first 10 strikes
    const optionsSummary = strikeKeys.map(strike => {
      const strikeData = strikes[strike]
      return {
        strike: strike,
        ce_ltp: strikeData.CE?.ltp || 0,
        ce_oi: strikeData.CE?.open_interest || 0,
        ce_iv: strikeData.CE?.greeks?.iv || 0,
        pe_ltp: strikeData.PE?.ltp || 0,
        pe_oi: strikeData.PE?.open_interest || 0,
        pe_iv: strikeData.PE?.greeks?.iv || 0,
      }
    })

    let promptContent = `Analyze the following option chain data for ${symbol} (underlying LTP: ₹${underlying_ltp}, Expiry: ${expiry_date}) and provide trading insights and detail_analysis:

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

    console.log(`Calling Azure OpenAI for ${symbol} analysis...`)

    const response = await axios.post(
      `${AZURE_OPENAI_ENDPOINT.replace(/\/+$/, '')}/openai/deployments/${AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=${AZURE_OPENAI_API_VERSION}`,
      {
        messages: [
          {
            role: 'user',
            content: promptContent,
          },
        ],
        max_tokens: 1024,
      },
      {
        headers: {
          'api-key': AZURE_OPENAI_API_KEY,
          'content-type': 'application/json',
        },
        timeout: 30000,
      }
    )

    console.log(`Azure OpenAI Response Status: ${response.status}`)

    if (response.status === 200 && response.data.choices && response.data.choices.length > 0) {
      const analysisText = response.data.choices[0].message.content
      console.log('AI analysis:', analysisText)
      // This route also predates analyzeWithAI - raw axios call, same as
      // /analyze-option-chain above.
      logAiUsage({ feature: 'ai_inference', usage: response.data.usage, model: AZURE_OPENAI_DEPLOYMENT, metadata: { symbol, underlying_symbol, exchange, expiry_date } })

      // Parse JSON from response
      let parsedAnalysis = null
      let explanation = ''
      
      try {
        // Try to extract JSON object from the text
        const jsonMatch = analysisText.match(/\{[\s\S]*\}/)
        if (jsonMatch) {
          parsedAnalysis = JSON.parse(jsonMatch[0])
          console.log('Successfully parsed analysis:', parsedAnalysis)
          
          // Extract explanation (text before JSON) and clean it
          const jsonStartIndex = analysisText.indexOf('{')
          if (jsonStartIndex > 0) {
            explanation = analysisText.substring(0, jsonStartIndex).trim()
          }
        } else {
          console.log('No JSON found in response, using raw text as explanation')
          explanation = analysisText
        }
        
        // Clean explanation: remove extra whitespace, newlines, and special characters
        explanation = explanation
          .replace(/[\n\r\t]/g, ' ')  // Replace newlines and tabs with space
          .replace(/\s+/g, ' ')        // Replace multiple spaces with single space
          .replace(/[{}[\]"'`]/g, '')  // Remove curly braces, brackets, quotes
          .trim()
          
      } catch (parseError) {
        console.error('Error parsing JSON:', parseError.message)
        explanation = analysisText
          .replace(/[\n\r\t]/g, ' ')
          .replace(/\s+/g, ' ')
          .replace(/[{}[\]"'`]/g, '')
          .trim()
      }

      // Return parsed_analysis and raw_text (explanation only, cleaned)
      return res.json({
        status: 'SUCCESS',
        symbol,
        underlying_symbol,
        underlying_ltp,
        expiry_date,
        exchange,
        parsed_analysis: parsedAnalysis,
        raw_text: explanation,
      })
    }

    res.status(500).json({
      error: 'Failed to get analysis from Azure OpenAI',
      status_code: response.status,
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

    const result = await analyzeWithAI(promptContent, {
      apiKey: AZURE_OPENAI_API_KEY,
      endpoint: AZURE_OPENAI_ENDPOINT,
      deployment: AZURE_OPENAI_DEPLOYMENT,
      apiVersion: AZURE_OPENAI_API_VERSION,
    })
    logAiUsage({ feature: 'compare_option_chain_snapshots', usage: result.usage, model: AZURE_OPENAI_DEPLOYMENT, metadata: { prompt_type } })

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
    const { parsed_analysis, raw_text, usage } = await analyzeWithAI(promptContent, {
      apiKey: AZURE_OPENAI_API_KEY,
      endpoint: AZURE_OPENAI_ENDPOINT,
      deployment: AZURE_OPENAI_DEPLOYMENT,
      apiVersion: AZURE_OPENAI_API_VERSION,
    })
    logAiUsage({ feature: 'regenerate_snapshot_analysis', usage, model: AZURE_OPENAI_DEPLOYMENT, metadata: { snapshot_id: req.params.id, prompt_type: resolvedPromptType } })
    await updateOptionChainSnapshotAnalysis(req.params.id, { parsed_analysis, raw_text, prompt_type: resolvedPromptType })
    res.json({ status: 'SUCCESS', snapshot: { ...snapshot, parsed_analysis, raw_text, prompt_type: resolvedPromptType } })
  } catch (error) {
    console.error('Regenerate Analysis Error:', error.message)
    res.status(error.response?.status || 500).json({ error: error.message })
  }
})

/**
 * Watchlist CRUD - the tracked-symbol config list. Fetching/analyzing is
 * done entirely by the watchlistTick scheduled function (deployed function
 * only - no scheduler in local dev); these routes just manage the list and
 * read back whatever the scheduler has already computed.
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
 * Latest computed analysis for one watchlist entry's tier (15m/75m) -
 * the Watchlist tab polls this on that tier's own cadence; it never
 * triggers analysis itself, only reads what watchlistTick already saved.
 */
app.get('/watchlist/:id/analysis/:tier', async (req, res) => {
  try {
    const { id, tier } = req.params
    if (!['15m', '75m'].includes(tier)) {
      return res.status(400).json({ error: 'tier must be one of 15m, 75m' })
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
 * Historical Chart feature - fetches candles from Groww on demand (storing
 * them in Firestore), and computes+stores indicator series from them. See
 * functions/growwHistoricalData.js/functions/technicalIndicators.js for the
 * actual logic; these two routes are thin wrappers, same shape as every
 * other route here.
 */
app.get('/historical-data', async (req, res) => {
  try {
    const accessToken = await getGrowwAccessToken()
    const symbol = req.query.symbol
    const exchange = req.query.exchange || 'NSE'
    const interval = req.query.interval || '1day'

    if (!symbol) {
      return res.status(400).json({ error: 'Missing symbol parameter' })
    }
    if (!req.query.start_time || !req.query.end_time) {
      return res.status(400).json({ error: 'Missing start_time or end_time parameter' })
    }

    let rangeStart, rangeEnd
    try {
      rangeStart = parseIstDateTime(req.query.start_time)
      rangeEnd = parseIstDateTime(req.query.end_time)
    } catch (error) {
      return res.status(400).json({ error: error.message })
    }

    let result
    try {
      result = await ensureCandlesFresh({ exchange, symbol, interval, rangeStart, rangeEnd, groww_token: accessToken })
    } catch (error) {
      console.error('Historical data fetch error:', error.message)
      return res.status(error.details?.status_code || 400).json(error.details || { error: error.message })
    }

    res.json({ status: 'SUCCESS', symbol, exchange, interval, candles: result.candles })
  } catch (error) {
    console.error('Error:', error.message)
    res.status(500).json({ error: error.message })
  }
})

app.get('/historical-data/indicators', async (req, res) => {
  try {
    const accessToken = await getGrowwAccessToken()
    const symbol = req.query.symbol
    const exchange = req.query.exchange || 'NSE'
    const interval = req.query.interval || '1day'
    const specs = (req.query.indicators || '').split(',').map((s) => s.trim()).filter(Boolean)

    if (!symbol) {
      return res.status(400).json({ error: 'Missing symbol parameter' })
    }
    if (!req.query.start_time || !req.query.end_time) {
      return res.status(400).json({ error: 'Missing start_time or end_time parameter' })
    }
    if (specs.length === 0) {
      return res.status(400).json({ error: 'Missing indicators parameter, e.g. SMA:20,RSI:14' })
    }

    let rangeStart, rangeEnd
    try {
      rangeStart = parseIstDateTime(req.query.start_time)
      rangeEnd = parseIstDateTime(req.query.end_time)
    } catch (error) {
      return res.status(400).json({ error: error.message })
    }

    let candles
    try {
      ;({ candles } = await ensureCandlesFresh({ exchange, symbol, interval, rangeStart, rangeEnd, groww_token: accessToken }))
    } catch (error) {
      console.error('Historical data fetch error:', error.message)
      return res.status(error.details?.status_code || 400).json(error.details || { error: error.message })
    }

    const series = {}
    for (const spec of specs) {
      try {
        series[spec] = await ensureIndicatorFresh({ symbol, exchange, interval, spec, candles })
      } catch (error) {
        console.error(`Indicator computation error for "${spec}":`, error.message)
        return res.status(400).json({ error: error.message })
      }
    }

    res.json({ status: 'SUCCESS', symbol, exchange, interval, series })
  } catch (error) {
    console.error('Error:', error.message)
    res.status(500).json({ error: error.message })
  }
})

/**
 * On-demand AI insight over the historical candles/indicators for a range -
 * reads the same Firestore-cached data the two routes above already
 * populate rather than trusting client-supplied series (a client could send
 * anything), builds a prompt, and calls Azure OpenAI directly - see
 * functions/historicalAiInsight.js for the prompt itself and
 * aiAnalysisPrompt.js's analyzeWithAI for the shared HTTP call. No
 * persistence - this is ephemeral, on-demand only (never triggered by the
 * historical-watchlist automation, by design - see functions/index.js's
 * historicalWatchlistFetchTask comment for why).
 */
app.post('/historical-data/ai-insight', async (req, res) => {
  try {
    const accessToken = await getGrowwAccessToken()
    const { symbol, exchange = 'NSE', interval = '1day', start_time, end_time, indicators } = req.body

    if (!symbol) return res.status(400).json({ error: 'Missing symbol parameter' })
    if (!start_time || !end_time) return res.status(400).json({ error: 'Missing start_time or end_time parameter' })

    let rangeStart, rangeEnd
    try {
      rangeStart = parseIstDateTime(start_time)
      rangeEnd = parseIstDateTime(end_time)
    } catch (error) {
      return res.status(400).json({ error: error.message })
    }

    let candles
    try {
      ;({ candles } = await ensureCandlesFresh({ exchange, symbol, interval, rangeStart, rangeEnd, groww_token: accessToken }))
    } catch (error) {
      console.error('Historical data fetch error:', error.message)
      return res.status(error.details?.status_code || 400).json(error.details || { error: error.message })
    }
    if (candles.length === 0) return res.status(400).json({ error: 'No candle data available for this range yet' })

    const specs = (indicators || '').split(',').map((s) => s.trim()).filter(Boolean)
    const indicatorSeries = {}
    for (const spec of specs) {
      try {
        indicatorSeries[spec] = await ensureIndicatorFresh({ symbol, exchange, interval, spec, candles })
      } catch (error) {
        console.error(`Indicator computation error for "${spec}":`, error.message)
      }
    }

    if (!AZURE_OPENAI_API_KEY || !AZURE_OPENAI_ENDPOINT || !AZURE_OPENAI_DEPLOYMENT) {
      return res.status(500).json({ error: 'Azure OpenAI is not configured' })
    }
    const promptContent = buildHistoricalInsightPrompt({ symbol, exchange, interval, candles, indicatorSeries })
    let result
    try {
      result = await analyzeWithAI(promptContent, {
        apiKey: AZURE_OPENAI_API_KEY,
        endpoint: AZURE_OPENAI_ENDPOINT,
        deployment: AZURE_OPENAI_DEPLOYMENT,
        apiVersion: AZURE_OPENAI_API_VERSION,
      })
      logAiUsage({ feature: 'historical_ai_insight', usage: result.usage, model: AZURE_OPENAI_DEPLOYMENT, metadata: { symbol, exchange, interval } })
    } catch (error) {
      // Previously uncaught here, so a raw axios error (e.g. a 404
      // DeploymentNotFound from a misconfigured AZURE_OPENAI_DEPLOYMENT)
      // fell through to the generic catch below and came back as an opaque
      // 500 with axios's own "Request failed with status code 404" instead
      // of Azure's actual, much more useful error message. 502 (not 500) -
      // this route's own logic is fine, it's the upstream AI dependency
      // that failed.
      const azureMessage = error.response?.data?.error?.message || error.message
      console.error('AI insight generation error:', azureMessage)
      return res.status(502).json({ error: `AI insight failed: ${azureMessage}` })
    }

    res.json({ status: 'SUCCESS', symbol, exchange, interval, ...result })
  } catch (error) {
    console.error('Error:', error.message)
    res.status(500).json({ error: error.message })
  }
})

/**
 * Search NSE/BSE cash-equity instruments by symbol OR company name - backs
 * the Chart tab's symbol picker. Separate from GET /underlying-symbols
 * above (a small curated F&O list shared by Greek Analysis/Compare too).
 * See functions/instrumentMasterSync.js.
 */
app.get('/instrument-search', async (req, res) => {
  try {
    const results = await searchInstruments(req.query.q, 50)
    res.json({ status: 'SUCCESS', results })
  } catch (error) {
    console.error('Error searching instruments:', error.message)
    res.status(500).json({ error: error.message })
  }
})

// Local-only: runs the daily instrumentMasterSync job on demand rather than
// waiting for its 6am IST schedule (deployed-only, same as every other
// onSchedule function in this app) - lets /instrument-search be populated
// and tested locally.
app.post('/instrument-master-sync', async (req, res) => {
  try {
    const result = await syncInstrumentMaster()
    res.json({ status: 'SUCCESS', ...result })
  } catch (error) {
    console.error('Error syncing instrument master:', error.message)
    res.status(500).json({ error: error.message })
  }
})

/**
 * Historical Watchlist - tracks (symbol, exchange, interval) combinations
 * for automated background refresh. The deployed Cloud Tasks pipeline
 * (historicalWatchlistDispatch/historicalWatchlistFetchTask in
 * functions/index.js) has no local equivalent - Cloud Tasks queues aren't
 * emulated locally, same precedent as watchlistTick having no local
 * scheduler. The manual trigger-fetch route below calls the exact same
 * processDueEntry logic directly, bypassing the queue, so the fetch/notify
 * behavior is still testable without deploying.
 */
app.post('/historical-watchlist', async (req, res) => {
  try {
    const { symbol, exchange, interval, indicatorSpecs } = req.body
    if (!symbol || !exchange || !interval) {
      return res.status(400).json({ error: 'Missing required fields', required: ['symbol', 'exchange', 'interval'] })
    }
    const id = await createHistoricalWatchlistEntry({ symbol, exchange, interval, indicatorSpecs })
    res.json({ status: 'SUCCESS', id })
  } catch (error) {
    console.error('Error creating historical watchlist entry:', error.message)
    res.status(500).json({ error: error.message })
  }
})

app.get('/historical-watchlist', async (req, res) => {
  try {
    const entries = await listActiveHistoricalWatchlistEntries()
    res.json({ status: 'SUCCESS', entries })
  } catch (error) {
    console.error('Error listing historical watchlist entries:', error.message)
    res.status(500).json({ error: error.message })
  }
})

app.delete('/historical-watchlist/:id', async (req, res) => {
  try {
    await deactivateHistoricalWatchlistEntry(req.params.id)
    res.json({ status: 'SUCCESS' })
  } catch (error) {
    console.error('Error removing historical watchlist entry:', error.message)
    res.status(500).json({ error: error.message })
  }
})

app.get('/historical-watchlist/notifications', async (req, res) => {
  try {
    const unreadOnly = req.query.unreadOnly === 'true'
    const notifications = await listHistoricalWatchlistNotifications({ unreadOnly })
    res.json({ status: 'SUCCESS', notifications })
  } catch (error) {
    console.error('Error listing historical watchlist notifications:', error.message)
    res.status(500).json({ error: error.message })
  }
})

app.post('/historical-watchlist/notifications/:id/read', async (req, res) => {
  try {
    await markHistoricalWatchlistNotificationRead(req.params.id)
    res.json({ status: 'SUCCESS' })
  } catch (error) {
    console.error('Error marking historical watchlist notification read:', error.message)
    res.status(500).json({ error: error.message })
  }
})

app.post('/historical-watchlist/notifications/mark-all-read', async (req, res) => {
  try {
    const count = await markAllHistoricalWatchlistNotificationsRead()
    res.json({ status: 'SUCCESS', count })
  } catch (error) {
    console.error('Error marking all historical watchlist notifications read:', error.message)
    res.status(500).json({ error: error.message })
  }
})

// Local-only: directly runs processDueEntry for one entry, bypassing Cloud
// Tasks (not emulated locally) - lets the fetch/notify logic be exercised
// without deploying.
app.post('/historical-watchlist/:id/trigger-fetch', async (req, res) => {
  try {
    const entry = await getHistoricalWatchlistEntry(req.params.id)
    if (!entry) return res.status(404).json({ error: 'Historical watchlist entry not found' })

    const accessToken = await getGrowwAccessToken()
    await processDueEntry(entry, { groww_token: accessToken })
    res.json({ status: 'SUCCESS' })
  } catch (error) {
    console.error('Error triggering historical watchlist fetch:', error.message)
    res.status(500).json({ error: error.message })
  }
})

/**
 * Error handlers
 */
app.use((_, res) => {
  res.status(404).json({ error: 'Endpoint not found' })
})

app.use((err, _, res) => {
  console.error('Internal error:', err.message)
  res.status(500).json({ error: 'Internal server error' })
})

/**
 * Serve React app for all non-API routes (client-side routing)
 */
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'))
})

/**
 * Start server
 */
const PORT = process.env.PORT || 5055
const DEBUG = process.env.DEBUG === 'true'

app.listen(PORT, () => {
  console.log(`Groww API Server running on http://localhost:${PORT}`)
  if (DEBUG) {
    console.log('Debug mode enabled')
  }
})
