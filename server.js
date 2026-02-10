/**
 * Groww API Backend Server - Node.js/Express Version
 * Handles authentication and proxies requests to Groww REST API
 */

import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import axios from 'axios'
import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

dotenv.config()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
app.use(cors())
app.use(express.json())

// Serve static files from dist folder (built React app)
app.use(express.static(path.join(__dirname, 'dist')))

// Groww API Configuration
const GROWW_API_BASE_URL = 'https://api.groww.in/v1'
const GROWW_API_VERSION = '1.0'
const INSTRUMENTS_JSON_LOCAL = './instruments-sample.json'

// Claude API Configuration
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY
const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages'
const CLAUDE_MODEL = 'claude-3-haiku-20240307'

/**
 * Extract access token from request headers
 */
function getAccessToken(req) {
  const authHeader = req.headers.authorization
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7)
  }
  return null
}

/**
 * Fetch instruments list from local sample JSON (no caching)
 */
async function fetchInstrumentsJSON() {
  try {
    console.log(`Fetching instruments from local sample JSON: ${INSTRUMENTS_JSON_LOCAL}`)
    const jsonData = readFileSync(INSTRUMENTS_JSON_LOCAL, 'utf-8')
    
    // Parse JSON
    const instruments = JSON.parse(jsonData)
    console.log(`Successfully fetched ${instruments.length} instruments from sample JSON`)
    return instruments
  } catch (error) {
    console.error('Error fetching instruments JSON:', error.message)
    return null
  }
}

/**
 * Generate a fresh access token from Groww API using API Key and Secret
 * Note: Currently using hardcoded token from .env
 */

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
    const accessToken = getAccessToken(req)
    if (!accessToken) {
      return res.status(401).json({ error: 'Unauthorized - Missing or invalid access token' })
    }

    const query = (req.query.q || '').trim()
    const intraday = req.query.intraday // Optional filter: 0 or 1

    if (!query || query.length < 1) {
      return res.status(400).json({ error: 'Search query too short' })
    }

    // Fetch from JSON - no caching
    let instruments = await fetchInstrumentsJSON()
    if (!instruments) {
      console.log('JSON fetch failed, returning empty results')
      return res.json([])
    }

    // Search: match query in symbol or name
    const queryLower = query.toLowerCase()
    let results = instruments
      .filter((i) => {
        const symbol = (i.trading_symbol || '').toLowerCase()
        const name = (i.name || '').toLowerCase()
        
        // Match if query is in symbol or name
        return (
          symbol.includes(queryLower) ||
          queryLower.includes(symbol) ||
          name.includes(queryLower)
        )
      })

    // Filter by is_intraday if provided
    if (intraday !== undefined && intraday !== null && intraday !== '') {
      const intradayValue = intraday === '1' || intraday === 1 || intraday === true
      results = results.filter((i) => {
        const isIntraday = i.is_intraday === 1 || i.is_intraday === '1' || i.is_intraday === true
        return isIntraday === intradayValue
      })
    }

    // Sort results - prioritize exact matches
    results = results
      .sort((a, b) => {
        const aSymbol = (a.trading_symbol || '').toLowerCase()
        const bSymbol = (b.trading_symbol || '').toLowerCase()
        
        // Exact match
        if (aSymbol === queryLower) return -1
        if (bSymbol === queryLower) return 1
        
        // Starts with query
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
    const accessToken = getAccessToken(req)
    if (!accessToken) {
      return res.status(401).json({ error: 'Unauthorized - Missing or invalid access token' })
    }

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
    const accessToken = getAccessToken(req)
    if (!accessToken) {
      return res.status(401).json({ error: 'Unauthorized - Missing or invalid access token' })
    }

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
    const accessToken = getAccessToken(req)
    if (!accessToken) {
      return res.status(401).json({ error: 'Unauthorized - Missing or invalid access token' })
    }

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
    const accessToken = getAccessToken(req)
    if (!accessToken) {
      return res.status(401).json({ error: 'Unauthorized - Missing or invalid access token' })
    }

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
    const accessToken = getAccessToken(req)
    if (!accessToken) {
      return res.status(401).json({ error: 'Unauthorized - Missing or invalid access token' })
    }

    const { symbol, underlying_symbol, trading_symbol, exchange, expiry_date, calculate_percentage } = req.body

    // Validate required fields
    if (!symbol || !underlying_symbol || !trading_symbol || !exchange || !expiry_date || calculate_percentage === undefined) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['symbol', 'underlying_symbol', 'trading_symbol', 'exchange', 'expiry_date', 'calculate_percentage'],
        received: Object.keys(req.body),
      })
    }

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
      // Prepare option chain summary for Claude
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

      const claudeResponse = await axios.post(
        CLAUDE_API_URL,
        {
          model: CLAUDE_MODEL,
          max_tokens: 1024,
          messages: [
            {
              role: 'user',
              content: promptContent,
            },
          ],
        },
        {
          headers: {
            'x-api-key': CLAUDE_API_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          timeout: 30000,
        }
      )

      if (claudeResponse.status === 200 && claudeResponse.data.content && claudeResponse.data.content.length > 0) {
        const analysisText = claudeResponse.data.content[0].text
        console.log('Claude Analysis received')

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
          error: 'Failed to get analysis from Claude API',
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
 * Get AI inference on market data using Claude API
 */
app.post('/ai/inference', async (req, res) => {
  try {
    const accessToken = getAccessToken(req)
    if (!accessToken) {
      return res.status(401).json({ error: 'Unauthorized - Missing or invalid access token' })
    }

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

    if (!CLAUDE_API_KEY) {
      return res.status(500).json({ error: 'Claude API key not configured' })
    }

    // Prepare option chain summary for Claude
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

    console.log(`Calling Claude API for ${symbol} analysis...`)

    const response = await axios.post(
      CLAUDE_API_URL,
      {
        model: CLAUDE_MODEL,
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: promptContent,
          },
        ],
      },
      {
        headers: {
          'x-api-key': CLAUDE_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        timeout: 30000,
      }
    )

    console.log(`Claude API Response Status: ${response.status}`)

    if (response.status === 200 && response.data.content && response.data.content.length > 0) {
      const analysisText = response.data.content[0].text
      console.log('Claude Analysis:', analysisText)

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
      error: 'Failed to get analysis from Claude API',
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
const PORT = process.env.PORT || 5000
const DEBUG = process.env.DEBUG === 'true'

app.listen(PORT, () => {
  console.log(`Groww API Server running on http://localhost:${PORT}`)
  if (DEBUG) {
    console.log('Debug mode enabled')
  }
})
