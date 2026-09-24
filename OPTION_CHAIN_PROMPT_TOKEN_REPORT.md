# Option Chain AI Prompt — Token Consumption Report

Generated 2026-09-24. Data source: the full `aiUsageLog` Firestore collection (1,312 documents — the entire logged history at the time of writing, 2026-09-22 13:06 UTC → 2026-09-24 06:16 UTC, ~1.7 days). Numbers below are real, not estimated.

Scope: this covers only the **option-chain analysis prompt** — the one that consumes the option chain (strikes, OI, volume, Greeks) as its input data. It's built by two style variants that always run together in production (see §3), so both are included here; the Historical Chart insight prompt and the unused legacy prompts are out of scope (covered separately in `AI_PROMPT_COST_REPORT.md`).

---

## 1. What data goes into the prompt

Both variants below are built from the same input transform, `summarizeStrikes()` in [functions/aiAnalysisPrompt.js:14-26](functions/aiAnalysisPrompt.js#L14-L26): every strike in the filtered range (`± points_range` around the underlying LTP) is mapped to:

```js
{
  strike,
  ce_ltp, ce_oi, ce_volume, ce_greeks,   // ce_greeks = full Greeks object (delta, gamma, theta, vega, iv, ...)
  pe_ltp, pe_oi, pe_volume, pe_greeks,   // pe_greeks = full Greeks object
}
```

This array is then `JSON.stringify(..., null, 2)` — full pretty-printed JSON — directly into the prompt. When a previous snapshot exists for the same instrument (used for OI-migration / change analysis), the **entire previous snapshot is embedded a second time**, in the same shape. Nothing is trimmed, aggregated, or summarized before being sent — the model receives the raw per-strike structure as-is.

This is the direct cause of the token volumes in §2: more strikes in range (wider `points_range`), and/or the presence of a previous snapshot, both scale the prompt size roughly linearly.

---

## 2. Token consumption — real data

### Per-day totals (option-chain prompt only)

| Day (UTC) | Calls | Prompt tokens | Completion tokens | Total tokens |
|---|---:|---:|---:|---:|
| 2026-09-22 (partial, logging started mid-day) | 0 | 0 | 0 | 0 |
| 2026-09-23 (full day) | 698 | 6,182,715 | 1,688,800 | 7,871,515 |
| 2026-09-24 (partial, cut off at export) | 548 | 4,745,714 | 1,334,505 | 6,080,219 |
| **All-time total** | **1,246** | **10,928,429** | **3,023,305** | **13,951,734** |

(Master + Summarized combined per day: 23rd = 349+349 calls, 4,089,350 + 3,782,165 tokens; 24th = 274+274 calls, 3,161,133 + 2,919,086 tokens.)

### Per-variant breakdown (all-time)

| Variant | Calls | Avg prompt tok | Min / Max prompt tok | Avg completion tok | Avg total tok/call |
|---|---:|---:|---:|---:|---:|
| Master Prompt (`watchlist_master_prompt`) | 623 | 8,931 | 1,780 / 17,909 | 2,707 | 11,638 |
| Summarized Recommendations (`watchlist_summarized_recommendations`) | 623 | 8,611 | 1,368 / 17,606 | 2,146 | 10,756 |

**Option-chain prompts as a share of all logged AI usage:** 1,246 of 1,312 total calls (95.0%), 13,951,734 of 15,002,034 total logged tokens (93.0%).

### Where the token range comes from

The 1,780–17,909 prompt-token spread across calls is driven by two things, per §1: how many strikes fall inside `points_range` for a given instrument/config (more strikes = more JSON), and whether a previous snapshot was available for OI-migration comparison (present ⇒ the whole chain is embedded twice, roughly doubling the option-chain portion of the prompt for that call).

---

## 3. Why there are two call counts for one "prompt"

The option-chain prompt has two style variants — Master Prompt (`buildInstitutionalAnalysisPrompt`) and Summarized Recommendations (`buildSummarizedRecommendationsPrompt`), both in [functions/aiAnalysisPrompt.js](functions/aiAnalysisPrompt.js) — that a user can pick between in the UI. In manual/on-demand routes only the selected style is called. But the automated Watchlist scheduler's `analyzeTier()` ([functions/watchlistScheduler.js:143-144](functions/watchlistScheduler.js#L143-L144)) calls **both, concurrently, every tier run**, regardless of which one is displayed — confirmed by the logs above, where Master and Summarized call counts are identical every single day (349/349, then 274/274). Since the scheduler accounts for the large majority of option-chain calls, this doubles the option-chain prompt's total token consumption compared to sending only the style actually in use.

---

## 4. The prompt(s), verbatim

### 4.1 Master Prompt — `buildInstitutionalAnalysisPrompt`

[functions/aiAnalysisPrompt.js:44-81](functions/aiAnalysisPrompt.js#L44-L81)

```
You are an institutional options strategist with expertise in NSE derivatives, market microstructure, option pricing, and Greeks.

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

Keep market_summary.narrative, institutional_positioning.summary, greeks_structure.risk_summary, iv_analysis.summary, oi_migration.summary, and each strategy_recommendations[].rationale to no more than 100 words each - concise and direct, not exhaustive. This does not apply to the shorter structured fields (levels, lists, badges, confidence).

market_summary.sentiment must be exactly one of "Bullish", "Bearish", or "Neutral" (this exact wording and casing, nothing else).

Return valid JSON only, matching exactly this structure (fill in every field - use empty strings/arrays/0 where a value is genuinely not supported by the data, but keep every key present):
${RESPONSE_SCHEMA}
```

Response schema:

```json
{
  "oi_structure": { "market_sentiment": "", "support_levels": [], "resistance_levels": [], "oi_clusters": [], "range_expectation": "", "institutional_defense": "", "observations": [], "confidence": "" },
  "institutional_positioning": { "overall_bias": "", "institutional_activity": [], "bullish_evidence": [], "bearish_evidence": [], "hedging_activity": [], "important_strikes": [], "summary": "(max 100 words)" },
  "greeks_structure": { "overall_greeks_bias": "", "gamma_walls": [], "high_delta_strikes": [], "theta_decay_strikes": [], "vega_hotspots": [], "iv_skew": "", "key_observations": [], "risk_summary": "(max 100 words)" },
  "oi_migration": { "available": true, "market_shift": "", "support_shift": "", "resistance_shift": "", "fresh_call_writing": [], "fresh_put_writing": [], "short_covering": [], "long_unwinding": [], "important_changes": [], "summary": "(max 100 words)" },
  "iv_analysis": { "volatility_bias": "", "premium_status": "", "iv_skew": "", "atm_analysis": "", "buyer_advantage": "", "seller_advantage": "", "expected_volatility": "", "recommended_strategies": [], "summary": "(max 100 words)" },
  "market_summary": { "sentiment": "Bullish|Bearish|Neutral", "confidence": 0, "support_level": 0, "resistance_level": 0, "expected_range": "", "smart_money_activity": "", "key_risks": [], "narrative": "(max 100 words)" },
  "strategy_recommendations": [ { "strategy": "", "rationale": "(max 100 words)", "risk_level": "" } ]
}
```

### 4.2 Summarized Recommendations — `buildSummarizedRecommendationsPrompt`

[functions/aiAnalysisPrompt.js:115-214](functions/aiAnalysisPrompt.js#L115-L214)

```
You are an institutional options strategist with expertise in NSE derivatives, option chain analysis, Greeks, volatility, and options trading strategies.

Analyze the following option chain data.

Underlying Price:
${current.underlying_ltp}

Expiry:
${current.expiry_date}

Option Chain:
${optionChainJson}
${previousSection}
Provide a concise but insightful analysis with two sections:

## 1. Key Elements

Identify the most important market observations, including but not limited to:

- Overall market sentiment (Bullish / Bearish / Neutral)
- Strongest support levels and why
- Strongest resistance levels and why
- Open Interest concentration
- Put-Call Ratio (if it can be inferred)
- Institutional positioning
- Significant Call/Put writing activity
- Significant Call/Put buying activity
- Gamma walls or important Greeks observations
- IV observations
- Premium behaviour
- Expected trading range
- Probability of breakout or breakdown
- Important risks or conflicting signals${changeElementBullet}

For every observation, briefly explain the reasoning based on OI, Greeks, IV, premium, and volume.${changeReasoningNote}

---

## 2. Recommended Trades

Recommend up to 5 option strategies that best suit the current market structure.

Possible strategies include (choose only those appropriate):

- Buy Call
- Buy Put
- Sell Call
- Sell Put
- Bull Call Spread
- Bear Put Spread
- Bull Put Spread
- Bear Call Spread
- Long Straddle
- Long Strangle
- Short Straddle
- Short Strangle
- Iron Condor
- Iron Butterfly
- Calendar Spread
- Diagonal Spread
- Covered Call
- Protective Put
- No Trade

For each recommendation provide:

- Strategy Name
- Market Bias
- Why this strategy fits the current option chain
- Suggested Strike Selection (ATM / ITM / OTM or specific strikes if evident)
- Entry rationale
- Profit expectation (Low / Medium / High)
- Risk level (Low / Medium / High)
- Confidence Score (0-100)${changeTradeNote}

If market conditions are unclear or conflicting, explicitly recommend "No Trade" rather than forcing a strategy.

Base every conclusion ONLY on the supplied option chain data. Do not invent information.

Keep each key_elements[].observation, key_elements[].reason, recommended_trades[].reason, and recommended_trades[].entry to no more than 100 words each - concise and direct, not exhaustive. This does not apply to the shorter structured fields (title, strategy, market_bias, suggested_strikes, profit_expectation, risk, confidence).

Return valid JSON only.

${SUMMARIZED_RECOMMENDATIONS_SCHEMA}
```

Response schema:

```json
{
  "key_elements": [
    { "title": "", "observation": "(max 100 words)", "reason": "(max 100 words)" }
  ],
  "recommended_trades": [
    { "strategy": "", "market_bias": "", "reason": "(max 100 words)", "suggested_strikes": "", "entry": "(max 100 words)", "profit_expectation": "", "risk": "", "confidence": 0 }
  ]
}
```

`optionChainJson` is the same full per-strike CE/PE/Greeks dump described in §1. `previousSection`/`changeElementBullet`/`changeReasoningNote`/`changeTradeNote` are populated only when a previous snapshot is passed — again, the entire previous option chain re-embedded.
