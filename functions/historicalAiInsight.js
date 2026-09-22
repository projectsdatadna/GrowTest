/**
 * On-demand AI insight prompt for the Historical Chart tab - reuses
 * analyzeWithAI from aiAnalysisPrompt.js as-is (already generic: prompt text
 * + Azure config in, {parsed_analysis, raw_text} out), so this file only
 * needs to build the prompt itself.
 */

function lastPoint(points) {
  return points && points.length > 0 ? points[points.length - 1] : null
}

// Summarizes every indicator series EXCEPT SR (support/resistance is a set
// of levels, not a single "latest value" - summarized separately below) by
// its most recent point, generically over whatever spec keys are present
// rather than hardcoding SMA/EMA/RSI/etc. by name.
function summarizeIndicators(indicatorSeries) {
  const lines = []
  for (const [spec, points] of Object.entries(indicatorSeries || {})) {
    if (spec.startsWith('SR:')) continue
    const point = lastPoint(points)
    if (!point) continue
    lines.push(`${spec}: ${JSON.stringify(point.value)}`)
  }
  return lines
}

function summarizeLevels(indicatorSeries) {
  return Object.entries(indicatorSeries || {})
    .filter(([spec]) => spec.startsWith('SR:'))
    .flatMap(([, points]) => points || [])
    .map((p) => `${p.value.type} at ${p.value.price.toFixed(2)} (${p.value.touches} touches)`)
}

/**
 * `candles` must be non-empty; `indicatorSeries` is the same
 * `{ 'SMA:20': [{timestamp,value}, ...], ... }` shape the frontend already
 * consumes - whatever the caller currently has computed, AI insight just
 * summarizes it, it does not compute anything itself.
 */
export function buildHistoricalInsightPrompt({ symbol, exchange, interval, candles, indicatorSeries }) {
  const first = candles[0]
  const last = candles[candles.length - 1]
  const rangeHigh = Math.max(...candles.map((c) => c.high))
  const rangeLow = Math.min(...candles.map((c) => c.low))
  const pctChange = first?.close ? (((last.close - first.close) / first.close) * 100).toFixed(2) : null

  const indicatorLines = summarizeIndicators(indicatorSeries)
  const levelLines = summarizeLevels(indicatorSeries)

  return `You are a technical analyst reviewing ${symbol} (${exchange}, ${interval} candles).

Price action over the loaded range (${candles.length} candles):
- Latest close: ${last.close}
- Range high/low: ${rangeHigh} / ${rangeLow}
- Change over range: ${pctChange !== null ? `${pctChange}%` : 'n/a'}

Latest indicator values:
${indicatorLines.length > 0 ? indicatorLines.map((l) => `- ${l}`).join('\n') : '- none computed'}

Support/Resistance levels (scripted, swing-point clustering):
${levelLines.length > 0 ? levelLines.map((l) => `- ${l}`).join('\n') : '- none computed'}

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
