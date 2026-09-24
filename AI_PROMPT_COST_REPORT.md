# AI Prompt Inventory & Token-Cost Report

Generated 2026-09-24. Data source: the full `aiUsageLog` Firestore collection (1,312 documents — the entire logged history at the time of writing, 2026-09-22 13:06 UTC → 2026-09-24 06:16 UTC, ~1.7 days). All numbers below are real, not estimated.

Model in use for every call: **`gpt-4.1-mini-pari`** (Azure OpenAI), via the single shared helper `analyzeWithAI()` in [functions/aiAnalysisPrompt.js:222-269](functions/aiAnalysisPrompt.js#L222-L269) — `max_tokens: 4096`, `response_format: { type: "json_object" }`, 100s timeout.

---

## 1. Prompt Catalog

There are **5 distinct prompt templates** in the codebase. Two are live and dominate cost; one is live but cheap; two are dead code.

### 1.1 `buildInstitutionalAnalysisPrompt` — "Master Prompt"

**File:** [functions/aiAnalysisPrompt.js:44-81](functions/aiAnalysisPrompt.js#L44-L81)
**Status:** Live — the #1 cost driver.
**Called from:**
- `POST /analyze-option-chain-range` (functions/index.js:520) — when style = master
- `POST /compare-option-chain-snapshots` (functions/index.js:648) — when style = master
- `POST /option-chain-snapshots/:id/regenerate-analysis` (functions/index.js:714) — when style = master
- `analyzeTier()` in [functions/watchlistScheduler.js:143](functions/watchlistScheduler.js#L143) — **always**, every tier run, unconditionally

**Exact prompt text** (template; `${...}` are runtime values):

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

Where `currentSummary` is every strike in range mapped to `{ strike, ce_ltp, ce_oi, ce_volume, ce_greeks, pe_ltp, pe_oi, pe_volume, pe_greeks }` (full Greeks object per side), and `previousSection` — when a prior same-instrument snapshot exists — repeats that **entire structure again** for the previous snapshot; otherwise it's a one-line note that OI migration isn't available.

**Response schema:**

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

---

### 1.2 `buildSummarizedRecommendationsPrompt` — "Summarized Recommendations"

**File:** [functions/aiAnalysisPrompt.js:115-214](functions/aiAnalysisPrompt.js#L115-L214)
**Status:** Live — the #2 cost driver, essentially tied with the Master Prompt.
**Called from:** the same 3 manual routes (when style = summarized) plus `analyzeTier()` — **always**, alongside the Master Prompt, every tier run.

**Exact prompt text** (template):

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

`optionChainJson` is the same full per-strike CE/PE/Greeks dump as the Master Prompt. `previousSection`, `changeElementBullet`, `changeReasoningNote`, and `changeTradeNote` are only non-empty when a previous snapshot is passed (again, the *entire* previous option chain re-embedded).

**Response schema:**

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

---

### 1.3 `buildHistoricalInsightPrompt` — Historical Chart AI Insight

**File:** [functions/historicalAiInsight.js:98-142](functions/historicalAiInsight.js#L98-L142)
**Status:** Live — cheap by design (see §3).
**Called from:** `POST /historical-data/ai-insight` (on-demand, from the Chart tab's "AI Insight" button) and the automated Historical Watchlist scheduler (feature `historical_watchlist_ai_insight`).

**Exact prompt text** (template):

```
You are a technical analyst reviewing ${symbol} (${exchange}, ${interval} candles).

Price action over the loaded range (${candles.length} candles):
- Latest close: ${last.close}
- Range high/low: ${rangeHigh} / ${rangeLow}
- Change over range: ${pctChange}%
- Last ${recentCloseCount} closes (oldest to newest): ${recentCloses}

Recent indicator values (oldest to newest, so you can see direction/momentum, not just a snapshot):
${indicatorLines}

Support/Resistance levels (scripted, swing-point clustering):
${levelLines}

Recent detected signals:
${eventLines}
${previousSection}

Respond with a single JSON object matching this exact schema, no extra commentary or markdown:
{
  "trend_summary": "",
  "momentum_assessment": "",
  "key_levels": [{ "type": "support|resistance", "price": 0, "note": "" }],
  "risk_factors": [""],
  "outlook": "bullish|bearish|neutral",
  "confidence": "low|medium|high"
}
```

Note what this prompt does **not** do: it never JSON-dumps raw candles or raw indicator series. It reduces the whole loaded range to a handful of scalars (latest close, range high/low, % change, last 10 closes) and short "oldest→newest" trend strings per indicator, plus optional 1-line-per-event signal summaries and a short "previous AI read" recap. This is the reason its token footprint is ~15x smaller than the two option-chain prompts (§3).

---

### 1.4 & 1.5 Legacy inline prompts — dead code, zero real usage

Two more prompts exist as inline template literals, each with its own schema, **not** using the shared builders above:

- **`POST /analyze-option-chain`** — [functions/index.js:423-436](functions/index.js#L423-L436) (logs as feature `analyze_option_chain`)
- **`POST /ai/inference`** — [functions/index.js:565-633](functions/index.js#L565-L633) (logs as feature `ai_inference`)

Both build a much lighter summary (first 10 strikes only, `ce_ltp`/`ce_oi`/`ce_iv`/`pe_ltp`/`pe_oi`/`pe_iv` — no full Greeks, no OI migration) and ask for `{ sentiment, support_level, resistance_level, strategy, risk_assessment, confidence, detail_analysis }`.

**Their only caller is `src/components/AIAnalysis.jsx`**, which `src/App.jsx:14` explicitly comments is a *hidden (not deleted)* tab — it's not reachable in the running UI. Consistent with that, the full `aiUsageLog` history (1,312 docs) contains **zero** entries for `analyze_option_chain` or `ai_inference`. These two prompts cost nothing today and are candidates for removal if the hidden tab is never coming back.

---

## 2. Real Usage Data (per day)

Source: full `aiUsageLog` collection, 1,312 documents, 2026-09-22 13:06 UTC → 2026-09-24 06:16 UTC. The first and last days are partial (logging started mid-day on the 22nd; the 24th is cut off at the export time), so treat day-over-day comparison as directional, not a full daily cycle.

| Day (UTC) | Total calls | Total tokens | `watchlist_master_prompt` | `watchlist_summarized_recommendations` | `historical_watchlist_ai_insight` | `historical_ai_insight` |
|---|---:|---:|---:|---:|---:|---:|
| 2026-09-22 (partial) | 2 | 975 | 0 | 0 | 0 | 2 |
| 2026-09-23 (full) | 761 | 7,919,231 | 349 (4,089,350 tok) | 349 (3,782,165 tok) | 62 (46,705 tok) | 1 (1,011 tok) |
| 2026-09-24 (partial) | 549 | 6,081,828 | 274 (3,161,133 tok) | 274 (2,919,086 tok) | 1 (1,609 tok) | 0 |

**All-time per-feature stats:**

| Feature | Calls | Avg prompt tokens | Min / Max prompt tokens | Avg completion tokens |
|---|---:|---:|---:|---:|
| `watchlist_master_prompt` | 623 | 8,931 | 1,780 / 17,909 | 2,707 |
| `watchlist_summarized_recommendations` | 623 | 8,611 | 1,368 / 17,606 | 2,146 |
| `historical_watchlist_ai_insight` | 63 | 544 | 477 / 1,254 | 223 |
| `historical_ai_insight` | 3 | 396 | 196 / 708 | 266 |

Other observations from the raw data:
- **`watchlist_master_prompt` and `watchlist_summarized_recommendations` call counts are identical every single day** (349/349, then 274/274) — direct confirmation that `analyzeTier()` fires both prompts together, every time, never just one.
- Tier split: **996 calls at the `15m` tier vs 250 at `75m`** — consistent with `TIER_MINUTES = { '15m': 15, '75m': 75 }` in [functions/watchlistScheduler.js:86](functions/watchlistScheduler.js#L86): the 15m tier runs on every tick, the 75m tier only every 5th tick.
- **25 distinct watchlist entries** are being tracked (from `watchlist_id` cardinality in the logged metadata).
- Only **2 of 1,312 calls (0.15%)** hit the 4,096-token completion cap — truncation is not a meaningful cost or quality factor at current volumes.
- Minor data-quality note: the `model` field is `"gpt-4.1-mini-pari\n"` (trailing newline) in 1,247 of 1,312 records, vs the clean `"gpt-4.1-mini-pari"` in the other 65 — cosmetic, harmless to cost, but worth trimming at the source if this log is ever grouped/exported by model name.

---

## 3. Root Cause Analysis: what's actually driving token cost

Three compounding factors, in order of impact:

### 3.1 Every watchlist tier run fires *both* prompts, unconditionally (the 2x multiplier)

[`analyzeTier()`](functions/watchlistScheduler.js#L117-L176) calls `buildInstitutionalAnalysisPrompt` and `buildSummarizedRecommendationsPrompt` **concurrently, every time**, regardless of which single "Prompt Style" a user has selected to view in the Watchlist UI. The three manual/on-demand routes (`/analyze-option-chain-range`, `/compare-option-chain-snapshots`, `/regenerate-analysis`) correctly call only one prompt per request based on the caller's chosen style — only the automated scheduler always does both. Since the scheduler accounts for 1,246 of the 1,312 logged calls (95%), this single behavior is responsible for roughly **double** the automation's AI spend compared to sending only the style actually being displayed.

### 3.2 Each call embeds the full raw option chain (why per-call cost is high)

Both option-chain prompts JSON-stringify **every strike in range**, both CE and PE, each carrying `ltp`, `open_interest`, `volume`, and a full `greeks` object — then, whenever a previous snapshot exists (which is most of the time once a watchlist entry has run a few ticks), the **entire previous snapshot is embedded again** for OI-migration comparison. That's why average prompt size is ~8,600–8,900 tokens per call, with some calls (wider `points_range`, more strikes) reaching 17,000+ tokens. Nothing is pre-aggregated or trimmed before being handed to the model — the model receives the same raw structure the app already computed for itself.

The Historical Chart's own `buildHistoricalInsightPrompt` (§1.3) is a working counter-example already in this codebase: it reduces an entire candle/indicator range to a dozen or so scalar values and short trend strings instead of dumping raw series, and its average prompt is ~544 tokens — about **1/16th** the size of the option-chain prompts. That gap is a direct measurement of what payload summarization is worth here.

### 3.3 Automation frequency compounds both of the above

The scheduler runs on market-hours ticks (every 15 minutes) across all active watchlist entries (25 currently), each entry running the `15m` tier every tick and the `75m` tier roughly every 5th tick — see `isTierDue()` at [functions/watchlistScheduler.js:104-109](functions/watchlistScheduler.js#L104-L109). With 25 entries × ~2 calls/tier-run × up to 2 tiers, spread across a ~6h15m trading day, this reproduces the observed ~600–760 calls/day. Frequency and entry count are both legitimate product requirements (this is what makes the watchlist "live"), but they're the multiplier applied on top of §3.1 and §3.2 — halving the per-run call count (§3.1) or the per-call payload (§3.2) would each cut total daily token spend roughly in half, independent of how many entries or how often they tick.

---

## 4. Appendix

- **Legacy dead code** (§1.4/1.5): `/analyze-option-chain` and `/ai/inference`, reachable only from the hidden `AIAnalysis.jsx` tab, zero logged usage. No cost impact today; candidates for deletion if that tab is permanently retired.
- **Model field logging glitch**: trailing `\n` on `model` in ~95% of `aiUsageLog` records (harmless, but breaks naive exact-string grouping in ad hoc exports/queries).
- **Completion-token cap**: 4,096-token cap on `analyzeWithAI()` is essentially never binding (2 of 1,312 calls) — not a current lever for cost or quality.
