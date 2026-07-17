/**
 * Shared institutional-grade option-chain analysis prompt + Azure OpenAI
 * call, used by both the deployed Cloud Function (functions/index.js) and
 * the local dev server (root server.js, which imports this file via a
 * relative path - see functions/firestoreClient.js for the same pattern).
 */

import axios from 'axios'

export function isSameInstrument(a, b) {
  return a.underlying_symbol === b.underlying_symbol && a.expiry_date === b.expiry_date && a.exchange === b.exchange
}

function summarizeStrikes(filteredStrikes) {
  return Object.entries(filteredStrikes || {}).map(([strike, data]) => ({
    strike,
    ce_ltp: data.CE?.ltp || 0,
    ce_oi: data.CE?.open_interest || 0,
    ce_volume: data.CE?.volume || 0,
    ce_greeks: data.CE?.greeks || {},
    pe_ltp: data.PE?.ltp || 0,
    pe_oi: data.PE?.open_interest || 0,
    pe_volume: data.PE?.volume || 0,
    pe_greeks: data.PE?.greeks || {},
  }))
}

const RESPONSE_SCHEMA = `{
  "oi_structure": { "market_sentiment": "", "support_levels": [], "resistance_levels": [], "oi_clusters": [], "range_expectation": "", "institutional_defense": "", "observations": [], "confidence": "" },
  "institutional_positioning": { "overall_bias": "", "institutional_activity": [], "bullish_evidence": [], "bearish_evidence": [], "hedging_activity": [], "important_strikes": [], "summary": "" },
  "greeks_structure": { "overall_greeks_bias": "", "gamma_walls": [], "high_delta_strikes": [], "theta_decay_strikes": [], "vega_hotspots": [], "iv_skew": "", "key_observations": [], "risk_summary": "" },
  "oi_migration": { "available": true, "market_shift": "", "support_shift": "", "resistance_shift": "", "fresh_call_writing": [], "fresh_put_writing": [], "short_covering": [], "long_unwinding": [], "important_changes": [], "summary": "" },
  "iv_analysis": { "volatility_bias": "", "premium_status": "", "iv_skew": "", "atm_analysis": "", "buyer_advantage": "", "seller_advantage": "", "expected_volatility": "", "recommended_strategies": [], "summary": "" },
  "market_summary": { "sentiment": "Bullish|Bearish|Neutral", "confidence": 0, "support_level": 0, "resistance_level": 0, "expected_range": "", "smart_money_activity": "", "key_risks": [], "narrative": "" },
  "strategy_recommendations": [ { "strategy": "", "rationale": "", "risk_level": "" } ]
}`

/**
 * Builds the institutional-analyst Master Prompt for one option chain
 * snapshot, optionally including a previous same-instrument snapshot for
 * OI Change & Migration analysis. `current`/`previous` are both
 * {underlying_symbol, underlying_ltp, expiry_date, filtered_strikes, points_range}-shaped.
 */
export function buildInstitutionalAnalysisPrompt(current, previous) {
  const currentSummary = summarizeStrikes(current.filtered_strikes)
  const previousSection = previous
    ? `Previous Snapshot (for OI Change & Migration Analysis):\n${JSON.stringify(summarizeStrikes(previous.filtered_strikes), null, 2)}`
    : 'No previous snapshot is available for this instrument. Set oi_migration.available to false and explain in oi_migration.summary that this analysis is based on the current snapshot only.'

  return `You are an institutional options strategist with expertise in NSE derivatives, market microstructure, option pricing, and Greeks.

Analyze the following option chain data for ${current.underlying_symbol} and produce a comprehensive institutional-quality report.

Underlying Price: ₹${current.underlying_ltp}
Expiry: ${current.expiry_date}

Current Option Chain (+/-${current.points_range} points around LTP, full Greeks + OI + volume per strike):
${JSON.stringify(currentSummary, null, 2)}

${previousSection}

Your analysis must include:
1. OI Structure Analysis - overall sentiment from CE vs PE OI, strongest support (highest Put OI) and resistance (highest Call OI) levels, significance of major OI clusters, whether writers are defending particular strikes, range-bound vs breakout read, unusual OI distribution, ATM vs far-OTM concentration, likely trading range until expiry.
2. Institutional Positioning Analysis - using OI, volume, premium, delta, gamma, vega, theta and IV, determine whether institutions are writing calls, writing puts, buying calls, buying puts, short covering, long unwinding, or hedging, and identify important strikes and smart-money activity near ATM.
3. Greeks Structure Analysis - delta distribution, gamma concentration/walls, vega concentration, theta decay zones, IV distribution and skew, call vs put Greeks comparison, which strikes are most price-sensitive and which face rapid premium decay.
4. OI Change & Migration Analysis - only if a previous snapshot is provided above: OI increases/decreases, fresh call/put writing, fresh call/put buying, long unwinding, short covering, migration of support/resistance, whether the structure has become more bullish or bearish. Explain every conclusion using OI movement and premium movement.
5. IV & Premium Analysis - overall IV level, distribution and skew, expensive vs cheap premiums, whether option buying or selling currently has the edge, probability of IV expansion/contraction, ATM premium quality.
6. Support & Resistance and Expected Trading Range.
7. Market Sentiment and Smart Money Activity.
8. Key Risks.
9. Suggested Option Strategies given the above.

Base every conclusion strictly on the supplied data - do not assume facts not supported by the option chain. Highlight conflicting signals where applicable, and where a section's schema includes a confidence field, assign Low/Medium/High.

market_summary.sentiment must be exactly one of "Bullish", "Bearish", or "Neutral" (this exact wording and casing, nothing else).

Return valid JSON only, matching exactly this structure (fill in every field - use empty strings/arrays/0 where a value is genuinely not supported by the data, but keep every key present):
${RESPONSE_SCHEMA}`
}

/**
 * Calls Azure OpenAI chat completions with a prompt that must return a
 * single JSON object (enforced via response_format), and parses it directly -
 * no preamble-stripping needed since json_object mode guarantees the whole
 * completion is one JSON object.
 */
export async function analyzeWithAI(promptContent, azureConfig, { maxTokens = 4096 } = {}) {
  const { apiKey, endpoint, deployment, apiVersion } = azureConfig

  if (!apiKey || !endpoint || !deployment) {
    throw new Error('Azure OpenAI is not configured (missing apiKey, endpoint, or deployment)')
  }

  const azureResponse = await axios.post(
    `${endpoint.replace(/\/+$/, '')}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`,
    {
      messages: [{ role: 'user', content: promptContent }],
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
    },
    {
      headers: {
        'api-key': apiKey,
        'content-type': 'application/json',
      },
      timeout: 60000,
    }
  )

  if (azureResponse.status !== 200 || !azureResponse.data.choices || azureResponse.data.choices.length === 0) {
    throw new Error('Failed to get analysis from Azure OpenAI')
  }

  const analysisText = azureResponse.data.choices[0].message.content

  try {
    const parsed_analysis = JSON.parse(analysisText.trim())
    return { parsed_analysis, raw_text: '' }
  } catch (parseError) {
    console.error('Error parsing AI JSON response:', parseError.message)
    return { parsed_analysis: null, raw_text: analysisText, warnings: ['json_parse_failed'] }
  }
}
