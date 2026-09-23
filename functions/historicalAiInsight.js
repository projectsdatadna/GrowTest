/**
 * AI insight prompt for the Historical Chart - reuses analyzeWithAI from
 * aiAnalysisPrompt.js as-is (already generic: prompt text + Azure config in,
 * {parsed_analysis, raw_text} out), so this file only needs to build the
 * prompt itself. Shared by both the on-demand route (POST
 * /historical-data/ai-insight, triggered by the Chart tab's "AI Insight"
 * button) and the automated per-entry run in historicalWatchlistScheduler.js
 * - the latter is the only caller that ever passes `previousAnalysis`.
 */

function lastPoint(points) {
  return points && points.length > 0 ? points[points.length - 1] : null
}

const EVENT_SPEC_PREFIXES = ['RSIDIV:', 'MACDCROSS:']
const EVENT_SPEC_LABELS = { 'RSIDIV:': 'RSI Divergence', 'MACDCROSS:': 'MACD Crossover' }

function isEventSpec(spec) {
  return EVENT_SPEC_PREFIXES.some((prefix) => spec.startsWith(prefix))
}

// Summarizes every indicator series except SR (a set of levels, not a
// per-candle value - summarized separately below) and the event-shaped
// specs (RSIDIV/MACDCROSS - each point's `value` is a {type, ...} event
// object, not a plain reading, so JSON-stringifying it here the same way
// would read as gibberish to the model; see summarizeEvents instead). Shows
// the last few points per spec (not just the latest) so the model can see
// direction/momentum - a single point can't distinguish "RSI at 55 and
// rising" from "RSI at 55 and falling".
function summarizeIndicators(indicatorSeries, recentCount = 5) {
  const lines = []
  for (const [spec, points] of Object.entries(indicatorSeries || {})) {
    if (spec.startsWith('SR:') || isEventSpec(spec)) continue
    if (!points || points.length === 0) continue
    const trail = points
      .slice(-recentCount)
      .map((p) => JSON.stringify(p.value))
      .join(' -> ')
    lines.push(`${spec}: ${trail}`)
  }
  return lines
}

function summarizeLevels(indicatorSeries) {
  return Object.entries(indicatorSeries || {})
    .filter(([spec]) => spec.startsWith('SR:'))
    .flatMap(([, points]) => points || [])
    .map((p) => `${p.value.type} at ${p.value.price.toFixed(2)} (${p.value.touches} touches)`)
}

function formatEventDate(timestampSeconds) {
  return new Date(timestampSeconds * 1000).toISOString().slice(0, 10)
}

// Lists the most recent bullish/bearish events from RSI Divergence and MACD
// Crossover specs, if either is currently enabled - the same underlying
// data DivergenceCard/CrossoverCard already render on the chart, just
// summarized as text instead of chart markers.
function summarizeEvents(indicatorSeries, recentCount = 5) {
  const lines = []
  for (const [spec, points] of Object.entries(indicatorSeries || {})) {
    if (!isEventSpec(spec) || !points || points.length === 0) continue
    const label = EVENT_SPEC_LABELS[EVENT_SPEC_PREFIXES.find((prefix) => spec.startsWith(prefix))]
    for (const event of points.slice(-recentCount)) {
      lines.push(`${label}: ${event.value.type} on ${formatEventDate(event.timestamp)}`)
    }
  }
  return lines
}

// Renders the entry's last stored automated analysis as a short "previous
// read" section, giving the model continuity across ticks (has the outlook
// actually changed, or is this the same read as last time?) - the same
// current/previous framing the option-chain Watchlist's prompts already
// use, just against this entry's own analysis history instead of a second
// live snapshot. Returns '' when there is none yet (first-ever automated
// run for this entry, or the on-demand route, which never has one).
function formatPreviousAnalysis(previousAnalysis) {
  const analysis = previousAnalysis?.parsed_analysis
  if (!analysis) return ''
  const ageMinutes = previousAnalysis.createdAt ? Math.round((Date.now() - new Date(previousAnalysis.createdAt).getTime()) / 60000) : null
  const ageText = ageMinutes != null ? `${ageMinutes} min ago` : 'previously'
  return `

Previous AI read (${ageText}):
- Outlook: ${analysis.outlook || 'n/a'} (confidence: ${analysis.confidence || 'n/a'})
- Trend summary: ${analysis.trend_summary || 'n/a'}`
}

/**
 * `candles` must be non-empty; `indicatorSeries` is the same
 * `{ 'SMA:20': [{timestamp,value}, ...], ... }` shape the frontend already
 * consumes - whatever the caller currently has computed, AI insight just
 * summarizes it, it does not compute anything itself. `previousAnalysis`
 * (optional) is a previously-stored `{ parsed_analysis, createdAt }` result
 * - only the automated Historical Watchlist path passes this.
 */
export function buildHistoricalInsightPrompt({ symbol, exchange, interval, candles, indicatorSeries, previousAnalysis = null }) {
  const first = candles[0]
  const last = candles[candles.length - 1]
  const rangeHigh = Math.max(...candles.map((c) => c.high))
  const rangeLow = Math.min(...candles.map((c) => c.low))
  const pctChange = first?.close ? (((last.close - first.close) / first.close) * 100).toFixed(2) : null
  const recentCloseCount = Math.min(10, candles.length)
  const recentCloses = candles
    .slice(-recentCloseCount)
    .map((c) => c.close)
    .join(', ')

  const indicatorLines = summarizeIndicators(indicatorSeries)
  const levelLines = summarizeLevels(indicatorSeries)
  const eventLines = summarizeEvents(indicatorSeries)
  const previousSection = formatPreviousAnalysis(previousAnalysis)

  return `You are a technical analyst reviewing ${symbol} (${exchange}, ${interval} candles).

Price action over the loaded range (${candles.length} candles):
- Latest close: ${last.close}
- Range high/low: ${rangeHigh} / ${rangeLow}
- Change over range: ${pctChange !== null ? `${pctChange}%` : 'n/a'}
- Last ${recentCloseCount} closes (oldest to newest): ${recentCloses}

Recent indicator values (oldest to newest, so you can see direction/momentum, not just a snapshot):
${indicatorLines.length > 0 ? indicatorLines.map((l) => `- ${l}`).join('\n') : '- none computed'}

Support/Resistance levels (scripted, swing-point clustering):
${levelLines.length > 0 ? levelLines.map((l) => `- ${l}`).join('\n') : '- none computed'}

Recent detected signals:
${eventLines.length > 0 ? eventLines.map((l) => `- ${l}`).join('\n') : '- none computed'}
${previousSection}

Respond with a single JSON object matching this exact schema, no extra commentary or markdown:
{
  "trend_summary": "",
  "momentum_assessment": "",
  "key_levels": [{ "type": "support|resistance", "price": 0, "note": "" }],
  "risk_factors": [""],
  "outlook": "bullish|bearish|neutral",
  "confidence": "low|medium|high"
}`
}
