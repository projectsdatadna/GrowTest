# Testing `server.js`

Sample data and reference requests/responses for exercising every endpoint in
[server.js](server.js) locally, plus the exact prompts sent to Claude for the
AI-inference endpoints.

## Setup

```bash
npm install
GROWW_API_KEY=... GROWW_API_SECRET=... PORT=5051 node server.js
```

No `Authorization` header is needed on any request anymore. The backend
exchanges `GROWW_API_KEY`/`GROWW_API_SECRET` (from Groww Cloud's API Keys
page) for a real Groww Access Token itself (`getGrowwAccessToken()` in
`server.js`), caches it, and uses it for every Groww-backed call — the
frontend no longer supplies or forwards any Groww credential.

`/search` reads from `instruments-sample.json` (10 rows: NIFTY, TCS, INFY,
RELIANCE, HDFC, WIPRO, BANKNIFTY, MARUTI, BAJAJFINSV, SBIN). That file did not
exist before — `INSTRUMENTS_JSON_LOCAL` in server.js pointed at it but only
`instruments-sample.csv` was present, so `/search` silently returned `[]`. It
now exists so `/search` works out of the box.

Endpoints that call the live Groww API (`/quote`, `/option-chain`,
`/historical`, `/analyze-option-chain`, `/analyze-option-chain-range`) will
fail if `GROWW_API_KEY`/`GROWW_API_SECRET` are missing or Groww's "daily
approval" step hasn't been done for the day — the error response includes a
`groww_error` field with Groww's real rejection reason. `/analyze-option-chain`
and `/ai/inference` additionally need `CLAUDE_API_KEY` set in `.env`.

---

## `GET /health`

```bash
curl http://localhost:5051/health
```

```json
{ "status": "ok", "message": "Groww API Server is running" }
```

## `GET /search`

```bash
curl "http://localhost:5051/search?q=TCS"
```

```json
[
  {
    "exchange": "NSE",
    "exchange_token": 56984,
    "trading_symbol": "TCS",
    "groww_symbol": "NSE-TCS",
    "name": "Tata Consultancy Services",
    "instrument_type": "EQUITY",
    "segment": "CASH",
    "underlying_symbol": "TCS",
    "underlying_exchange_token": 13062,
    "lot_size": 1,
    "tick_size": 0.05,
    "is_intraday": 0
  }
]
```

## `GET /quote`

```bash
curl "http://localhost:5051/quote?symbol=TCS&exchange=NSE"
```

Proxies straight to `GET https://api.groww.in/v1/live-data/quote`. If
`GROWW_API_KEY`/`GROWW_API_SECRET` are missing or Groww rejects the exchange:

```json
{ "error": "Failed to generate Groww access token: ...", "groww_error": { "...": "Groww's real error body" } }
```

Sample shape of a real success response (Groww's schema):

```json
{
  "trading_symbol": "TCS",
  "exchange": "NSE",
  "segment": "CASH",
  "last_price": 3842.5,
  "day_change": 12.35,
  "day_change_perc": 0.32,
  "open": 3830.0,
  "high": 3855.0,
  "low": 3825.1,
  "close": 3830.15,
  "volume": 1520340
}
```

## `GET /option-expiries`

```bash
curl "http://localhost:5051/option-expiries?symbol=NIFTY&exchange=NSE"
```

If the Groww expiries call fails (e.g. token exchange not configured), the
route falls back to a computed default (next Thursday) rather than erroring:

```json
{ "status": "SUCCESS", "expiry_dates": ["2026-07-09"] }
```

## `GET /option-chain`

```bash
curl "http://localhost:5051/option-chain?underlying_symbol=NIFTY&exchange=NSE&expiry_date=2026-07-09"
```

Sample shape of a real success response:

```json
{
  "status": "SUCCESS",
  "payload": {
    "underlying_ltp": 24500.25,
    "expiry_date": "2026-07-09",
    "strikes": {
      "24400": {
        "CE": { "ltp": 145.2, "open_interest": 125000, "greeks": { "iv": 13.4 } },
        "PE": { "ltp": 32.1, "open_interest": 98000, "greeks": { "iv": 14.1 } }
      },
      "24500": {
        "CE": { "ltp": 88.5, "open_interest": 210000, "greeks": { "iv": 12.9 } },
        "PE": { "ltp": 70.4, "open_interest": 185000, "greeks": { "iv": 13.2 } }
      },
      "24600": {
        "CE": { "ltp": 45.0, "open_interest": 160000, "greeks": { "iv": 12.5 } },
        "PE": { "ltp": 128.9, "open_interest": 140000, "greeks": { "iv": 13.8 } }
      }
    }
  }
}
```

## `GET /historical`

```bash
curl "http://localhost:5051/historical?symbol=TCS&exchange=NSE&interval=1day&count=5"
```

If the Groww call fails, the route returns:

```json
{ "error": "Unable to fetch historical data for TCS.", "symbol": "TCS", "exchange": "NSE" }
```

## `POST /analyze-option-chain`

Fetches a live option chain, filters strikes to a percentage band around
underlying LTP, then calls Claude for insights.

```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{
    "symbol": "NIFTY",
    "underlying_symbol": "NIFTY",
    "trading_symbol": "NIFTY",
    "exchange": "NSE",
    "expiry_date": "2026-07-09",
    "calculate_percentage": 2
  }' \
  "http://localhost:5051/analyze-option-chain"
```

Missing-field validation response (no live Groww/Claude needed to see this):

```json
{
  "error": "Missing required fields",
  "required": ["symbol", "underlying_symbol", "trading_symbol", "exchange", "expiry_date", "calculate_percentage"],
  "received": []
}
```

### Prompt sent to Claude (built from `server.js:548-561`)

`CLAUDE_MODEL = "claude-3-haiku-20240307"`, `max_tokens: 1024`.

```
Analyze the following option chain data for NIFTY (underlying LTP: ₹24500.25, Expiry: 2026-07-09) and provide trading insights and detail_analysis:

Option Chain Summary:
[
  {
    "strike": "24400",
    "ce_ltp": 145.2,
    "ce_oi": 125000,
    "ce_iv": 13.4,
    "pe_ltp": 32.1,
    "pe_oi": 98000,
    "pe_iv": 14.1
  },
  {
    "strike": "24500",
    "ce_ltp": 88.5,
    "ce_oi": 210000,
    "ce_iv": 12.9,
    "pe_ltp": 70.4,
    "pe_oi": 185000,
    "pe_iv": 13.2
  },
  {
    "strike": "24600",
    "ce_ltp": 45.0,
    "ce_oi": 160000,
    "ce_iv": 12.5,
    "pe_ltp": 128.9,
    "pe_oi": 140000,
    "pe_iv": 13.8
  }
]

Please provide:
1. Market sentiment (Bullish/Bearish/Neutral)
2. Key support and resistance levels based on option data
3. Recommended trading strategy
4. Risk assessment
5. Confidence level (0-100)
6. Detail Analysis

Format your response as JSON with keys: sentiment, support_level, resistance_level, strategy, risk_assessment, confidence, detail_analysis
```

### Sample Claude response text (what `content[0].text` looks like)

```
Based on the option chain data, here is my analysis:

{
  "sentiment": "Neutral",
  "support_level": "24400",
  "resistance_level": "24600",
  "strategy": "Consider a short strangle selling the 24400 PE and 24600 CE given balanced open interest on both sides, or an iron condor to cap risk.",
  "risk_assessment": "Moderate - IV is fairly flat across strikes (12.5%-14.1%), suggesting no strong directional bias priced in. Watch OI shifts near expiry.",
  "confidence": 62,
  "detail_analysis": "Open interest is concentrated at the 24500 strike on both CE and PE, marking it as the likely max-pain / pivot point. Slightly higher OI on the CE side at 24500 (210000 vs 185000) hints at mild resistance overhead, while the 24400 PE and 24600 CE show comparable OI, reinforcing a range-bound expectation between 24400 and 24600. IV skew is minimal, indicating the market is not pricing a large move before expiry."
}
```

### Resulting API response shape

```json
{
  "status": "SUCCESS",
  "symbol": "NIFTY",
  "underlying_symbol": "NIFTY",
  "underlying_ltp": 24500.25,
  "expiry_date": "2026-07-09",
  "exchange": "NSE",
  "filteredStrikes": { "...": "strikes within the ±2% band" },
  "calculated_range": { "min": "24010.25", "max": "24990.25" },
  "filtered_strikes_count": 3,
  "parsed_analysis": { "...": "the JSON object shown above" },
  "raw_text": "Based on the option chain data, here is my analysis:"
}
```

## `POST /analyze-option-chain-range`

Like `/analyze-option-chain`, but filters strikes to a fixed **+/- points**
band around the underlying LTP (default 500, no percentage math) and sends
**all** filtered strikes with **full Greeks** (delta/gamma/theta/vega/rho/iv)
to Claude instead of just the first 10 strikes' IV.

```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{
    "symbol": "NIFTY",
    "underlying_symbol": "NIFTY",
    "trading_symbol": "NIFTY31JUL2625000CE",
    "exchange": "NSE",
    "expiry_date": "2026-07-31",
    "points_range": 500
  }' \
  "http://localhost:5051/analyze-option-chain-range"
```

`points_range` is optional and defaults to `500` if omitted.

Missing-field validation response (no live Groww/Claude needed to see this):

```json
{
  "error": "Missing required fields",
  "required": ["symbol", "underlying_symbol", "trading_symbol", "exchange", "expiry_date"],
  "received": []
}
```

### Prompt sent to Claude (built from `server.js:analyzeWithClaude` call site)

Same 6-point format as `/analyze-option-chain`, but each strike entry carries
full Greeks objects instead of a single `_iv` field:

```
Analyze the following option chain data for NIFTY31JUL2625000CE (underlying LTP: ₹24500.25, Expiry: 2026-07-31) and provide trading insights and detail_analysis:

Option Chain Summary (+/-500 points around LTP, full Greeks per strike):
[
  {
    "strike": "24000",
    "ce_ltp": 520.0,
    "ce_oi": 90000,
    "ce_greeks": { "delta": 0.62, "gamma": 0.0011, "theta": -5.2, "vega": 12.1, "rho": 3.4, "iv": 14.1 },
    "pe_ltp": 45.0,
    "pe_oi": 60000,
    "pe_greeks": { "delta": -0.2, "gamma": 0.0009, "theta": -3.1, "vega": 10.8, "rho": -1.2, "iv": 15.0 }
  },
  {
    "strike": "24500",
    "ce_ltp": 88.5,
    "ce_oi": 210000,
    "ce_greeks": { "delta": 0.48, "gamma": 0.0021, "theta": -6.4, "vega": 14.2, "rho": 2.6, "iv": 12.9 },
    "pe_ltp": 70.4,
    "pe_oi": 185000,
    "pe_greeks": { "delta": -0.51, "gamma": 0.0020, "theta": -6.1, "vega": 14.0, "rho": -2.8, "iv": 13.2 }
  },
  {
    "strike": "25000",
    "ce_ltp": 40.0,
    "ce_oi": 200000,
    "ce_greeks": { "delta": 0.35, "gamma": 0.0018, "theta": -4.1, "vega": 10.5, "rho": 2.1, "iv": 12.8 },
    "pe_ltp": 480.0,
    "pe_oi": 50000,
    "pe_greeks": { "delta": -0.65, "gamma": 0.0015, "theta": -3.8, "vega": 9.6, "rho": -3.9, "iv": 16.2 }
  }
]

Please provide:
1. Market sentiment (Bullish/Bearish/Neutral)
2. Key support and resistance levels based on option data
3. Recommended trading strategy
4. Risk assessment
5. Confidence level (0-100)
6. Detail Analysis
7. Five additional 0-100 market-pulse scores: price_strength, momentum, volatility_score, buying_pressure, selling_pressure, institutional_activity

Format your response as JSON with keys: sentiment, support_level, resistance_level, strategy, risk_assessment, confidence, detail_analysis, price_strength, momentum, volatility_score, buying_pressure, selling_pressure, institutional_activity
```

### Resulting API response shape

```json
{
  "status": "SUCCESS",
  "symbol": "NIFTY31JUL2625000CE",
  "underlying_symbol": "NIFTY",
  "trading_symbol": "NIFTY31JUL2625000CE",
  "underlying_ltp": 24500.25,
  "expiry_date": "2026-07-31",
  "exchange": "NSE",
  "points_range": 500,
  "calculated_range": { "min": "24000.25", "max": "25000.25" },
  "filtered_strikes": { "...": "every strike within the +/-500 band, full CE/PE objects incl. greeks" },
  "filtered_strikes_count": 3,
  "parsed_analysis": {
    "...": "the JSON object shown above, now also including",
    "price_strength": 68, "momentum": 55, "volatility_score": 40,
    "buying_pressure": 62, "selling_pressure": 38, "institutional_activity": 57
  },
  "raw_text": "Based on the option chain data, here is my analysis:"
}
```

### UI test values (`Greek Analysis` tab)

Matches the NIFTY row in `instruments-sample.json` (expiry `2026-07-31`):

| Field | Value |
|---|---|
| Exchange | `NSE` |
| Underlying Symbol | `NIFTY` |
| Trading Symbol | `NIFTY31JUL2625000CE` |
| Expiry Date | `2026-07-31` |
| Points Range | `500` (default) |

No login step or token entry needed — the backend authenticates to Groww
itself using `GROWW_API_KEY`/`GROWW_API_SECRET` from its `.env`.

## `POST /ai/inference`

Same Claude prompt/response shape as above but takes the option chain
directly in the request body instead of fetching it from Groww.

```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{
    "symbol": "NIFTY",
    "underlying_symbol": "NIFTY",
    "underlying_ltp": 24500.25,
    "exchange": "NSE",
    "expiry_date": "2026-07-09",
    "strikes": {
      "24400": { "CE": { "ltp": 145.2, "open_interest": 125000, "greeks": { "iv": 13.4 } }, "PE": { "ltp": 32.1, "open_interest": 98000, "greeks": { "iv": 14.1 } } },
      "24500": { "CE": { "ltp": 88.5, "open_interest": 210000, "greeks": { "iv": 12.9 } }, "PE": { "ltp": 70.4, "open_interest": 185000, "greeks": { "iv": 13.2 } } },
      "24600": { "CE": { "ltp": 45.0, "open_interest": 160000, "greeks": { "iv": 12.5 } }, "PE": { "ltp": 128.9, "open_interest": 140000, "greeks": { "iv": 13.8 } } }
    }
  }' \
  "http://localhost:5051/ai/inference"
```

### Prompt sent to Claude (built from `server.js:702-715`)

Identical structure to `/analyze-option-chain`'s prompt except point 6 reads
"Explain your analysis in detail" instead of "Detail Analysis":

```
Analyze the following option chain data for NIFTY (underlying LTP: ₹24500.25, Expiry: 2026-07-09) and provide trading insights and detail_analysis:

Option Chain Summary:
[ ... same optionsSummary array as above ... ]

Please provide:
1. Market sentiment (Bullish/Bearish/Neutral)
2. Key support and resistance levels based on option data
3. Recommended trading strategy
4. Risk assessment
5. Confidence level (0-100)
6. Explain your analysis in detail

Format your response as JSON with keys: sentiment, support_level, resistance_level, strategy, risk_assessment, confidence, detail_analysis
```

### Resulting API response shape

```json
{
  "status": "SUCCESS",
  "symbol": "NIFTY",
  "underlying_symbol": "NIFTY",
  "underlying_ltp": 24500.25,
  "expiry_date": "2026-07-09",
  "exchange": "NSE",
  "parsed_analysis": { "...": "same JSON object as the sample Claude response above" },
  "raw_text": "Based on the option chain data, here is my analysis:"
}
```

Missing required fields → `400` with the field list; missing `CLAUDE_API_KEY`
→ `500 { "error": "Claude API key not configured" }`.

## `POST /compare-option-chain-snapshots`

Powers Greek Analysis' Zone 3 (Trend Comparison): takes two full
`/analyze-option-chain-range` response snapshots (typically ~15 minutes
apart, per the frontend's auto-refresh) and asks Claude to interpret the
trend between them, reusing the same `analyzeWithClaude` helper as the
other AI-inference endpoints.

```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{
    "previous": { "trading_symbol": "NIFTY", "underlying_ltp": 24450.0, "parsed_analysis": { "sentiment": "Neutral", "support_level": "24200", "resistance_level": "24700", "confidence": 55, "strategy": "Iron condor" } },
    "latest":   { "trading_symbol": "NIFTY", "underlying_ltp": 24580.0, "parsed_analysis": { "sentiment": "Bullish", "support_level": "24300", "resistance_level": "24800", "confidence": 68, "strategy": "Bull call spread" } }
  }' \
  "http://localhost:5051/compare-option-chain-snapshots"
```

Missing either snapshot → `400`:

```json
{ "error": "Both previous and latest snapshots are required", "required": ["previous", "latest"], "received": [] }
```

### Resulting API response shape

```json
{
  "status": "SUCCESS",
  "parsed_comparison": {
    "trend": "Strengthening",
    "ltp_change_summary": "NIFTY rose ~130 points (24450 -> 24580) over the last 15 minutes.",
    "sentiment_shift": "Shifted from Neutral to Bullish as price broke above the prior resistance zone.",
    "updated_recommendation": "Consider rolling into a bull call spread given the breakout.",
    "confidence": 70,
    "narrative": "The move above 24500 with rising confidence suggests short-term bullish momentum is building."
  },
  "raw_text": "Comparing the two snapshots:"
}
```

## `GET /nope` (unmatched route)

```json
{ "error": "Endpoint not found" }
```
