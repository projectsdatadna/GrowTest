/**
 * Pure helper functions for Greek Analysis's derived widgets. Every value
 * here is computed from real snapshot data (never fabricated) - see the
 * "Data mapping" table in the implementation plan for what backs each one.
 */

/**
 * Splits sentiment+confidence into complementary bull/bear percentages for
 * the Probability Gauge. Neutral has no directional lean, so it's an even split.
 */
export function computeProbabilityGauge(parsedAnalysis) {
  const confidence = Number(parsedAnalysis?.confidence)
  const clamped = Number.isFinite(confidence) ? Math.min(100, Math.max(0, confidence)) : 50
  const sentiment = (parsedAnalysis?.sentiment || '').toLowerCase()

  if (sentiment === 'bullish') return { bullishPct: clamped, bearishPct: 100 - clamped }
  if (sentiment === 'bearish') return { bullishPct: 100 - clamped, bearishPct: clamped }
  return { bullishPct: 50, bearishPct: 50 }
}

const NUMBERED_POINT_RE = /(?:^|\n|\.\s+)(\d{1,2})[.)]\s+(?=[A-Z])/g
const BULLET_LINE_RE = /^\s*[-•*]\s+/

/**
 * Detects whether a free-text AI narrative/summary field is actually a
 * numbered or bulleted list written out as one string (the schema defines
 * these fields as plain strings, but the model frequently numbers its
 * points within them) - so it can be rendered as real list items instead of
 * one run-on paragraph. The numbered-marker regex requires the digit to
 * follow start-of-string, a newline, or ". " and precede a capital letter,
 * which keeps it from misfiring on ordinary numbers in prose (e.g. a price
 * like "24500." doesn't match, since its digits are preceded by another
 * digit, not a sentence/line boundary). Returns null when the text is just
 * prose - callers should fall back to rendering it as-is.
 */
export function splitNarrativePoints(text) {
  if (typeof text !== 'string' || !text.trim()) return null
  const trimmed = text.trim()

  const numberedMatches = [...trimmed.matchAll(NUMBERED_POINT_RE)]
  if (numberedMatches.length >= 2) {
    const points = numberedMatches
      .map((m, i) => {
        const start = m.index + m[0].length
        const end = i + 1 < numberedMatches.length ? numberedMatches[i + 1].index : trimmed.length
        return trimmed.slice(start, end).trim()
      })
      .filter(Boolean)
    if (points.length >= 2) return { type: 'numbered', points }
  }

  const lines = trimmed
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.length >= 2 && lines.every((l) => BULLET_LINE_RE.test(l))) {
    return { type: 'bullet', points: lines.map((l) => l.replace(BULLET_LINE_RE, '')) }
  }

  return null
}

/**
 * Normalizes the new Master Prompt schema's `market_summary` object and the
 * old flat schema (`sentiment`/`confidence`/`support_level`/`resistance_level`
 * at the top level of `parsed_analysis`) into one shape, so Overall Bias/AI
 * Final Insight/Probability Gauge render real data for legacy snapshots
 * instead of going blank - the shared Firestore collection holds a permanent
 * mix of both schemas.
 */
export function getMarketSummary(parsedAnalysis) {
  if (!parsedAnalysis) return null
  if (parsedAnalysis.market_summary) return parsedAnalysis.market_summary
  if (!parsedAnalysis.sentiment) return null
  return {
    sentiment: parsedAnalysis.sentiment,
    confidence: parsedAnalysis.confidence,
    support_level: parsedAnalysis.support_level,
    resistance_level: parsedAnalysis.resistance_level,
    narrative: undefined,
  }
}

function collectMatchedStrikes(previous, latest) {
  if (!previous?.filtered_strikes || !latest?.filtered_strikes) return []
  return Object.keys(latest.filtered_strikes).filter((strike) => previous.filtered_strikes[strike])
}

/**
 * OI deltas (latest - previous) per strike/type, for strikes present in both
 * snapshots. Returns the top-N by absolute combined change, plus separate
 * top-N CE and PE buildup (positive change) lists, for the OI Buildup panels.
 */
export function computeOiChanges(previous, latest, topN = 5) {
  const matched = collectMatchedStrikes(previous, latest)
  if (matched.length === 0) return { keyStrikeChanges: [], topCallBuildup: [], topPutBuildup: [] }

  const rows = []
  matched.forEach((strike) => {
    ;['CE', 'PE'].forEach((type) => {
      const prevLeg = previous.filtered_strikes[strike]?.[type]
      const latestLeg = latest.filtered_strikes[strike]?.[type]
      if (!prevLeg || !latestLeg) return
      const oiChange = (latestLeg.open_interest || 0) - (prevLeg.open_interest || 0)
      rows.push({ strike, type, oiChange, latestOi: latestLeg.open_interest || 0 })
    })
  })

  const keyStrikeChanges = [...rows].sort((a, b) => Math.abs(b.oiChange) - Math.abs(a.oiChange)).slice(0, topN)
  const topCallBuildup = rows
    .filter((r) => r.type === 'CE' && r.oiChange > 0)
    .sort((a, b) => b.oiChange - a.oiChange)
    .slice(0, topN)
  const topPutBuildup = rows
    .filter((r) => r.type === 'PE' && r.oiChange > 0)
    .sort((a, b) => b.oiChange - a.oiChange)
    .slice(0, topN)

  return { keyStrikeChanges, topCallBuildup, topPutBuildup }
}

// Anything averaging out to less than this reads as "unchanged" - keeps the
// reason text, icon direction, and displayed sign (all derived from this same
// threshold) mutually consistent instead of an exact/near-zero change
// silently falling into the negative-sounding branch.
const GREEK_CHANGE_EPSILON = 0.00005

const GREEK_REASON = {
  delta: (change) =>
    change > GREEK_CHANGE_EPSILON ? 'Bullish delta shift' : change < -GREEK_CHANGE_EPSILON ? 'Bearish delta shift' : 'Delta unchanged',
  gamma: (change) =>
    change > GREEK_CHANGE_EPSILON ? 'Gamma acceleration' : change < -GREEK_CHANGE_EPSILON ? 'Gamma deceleration' : 'Gamma unchanged',
  theta: (change) =>
    change < -GREEK_CHANGE_EPSILON ? 'Time decay increasing' : change > GREEK_CHANGE_EPSILON ? 'Time decay easing' : 'Time decay unchanged',
  vega: (change) =>
    change > GREEK_CHANGE_EPSILON ? 'IV expansion' : change < -GREEK_CHANGE_EPSILON ? 'IV contraction' : 'IV unchanged',
}

/**
 * Average change per Greek (delta/gamma/theta/vega) across every CE+PE leg
 * present in both snapshots - an aggregate digest, not a full per-strike
 * table (that's what the Previous/Current cards already show in full).
 */
export function computeGreeksDelta(previous, latest) {
  const matched = collectMatchedStrikes(previous, latest)
  if (matched.length === 0) return []

  const sums = { delta: 0, gamma: 0, theta: 0, vega: 0 }
  const prevSums = { delta: 0, gamma: 0, theta: 0, vega: 0 }
  let legCount = 0

  matched.forEach((strike) => {
    ;['CE', 'PE'].forEach((type) => {
      const prevGreeks = previous.filtered_strikes[strike]?.[type]?.greeks
      const latestGreeks = latest.filtered_strikes[strike]?.[type]?.greeks
      if (!prevGreeks || !latestGreeks) return
      legCount++
      ;['delta', 'gamma', 'theta', 'vega'].forEach((key) => {
        sums[key] += (latestGreeks[key] || 0) - (prevGreeks[key] || 0)
        prevSums[key] += prevGreeks[key] || 0
      })
    })
  })

  if (legCount === 0) return []

  return ['delta', 'gamma', 'theta', 'vega'].map((key) => {
    const avgChange = sums[key] / legCount
    const avgPrev = prevSums[key] / legCount
    const pctChange = avgPrev !== 0 ? (avgChange / Math.abs(avgPrev)) * 100 : 0
    const direction = avgChange > GREEK_CHANGE_EPSILON ? 'up' : avgChange < -GREEK_CHANGE_EPSILON ? 'down' : 'flat'
    return {
      key,
      label: key[0].toUpperCase() + key.slice(1),
      avgChange,
      pctChange,
      direction,
      reason: GREEK_REASON[key](avgChange),
    }
  })
}

/** Triggers a browser download of the current 3-zone data as JSON. */
export function exportSnapshotsAsJson(latest, previous, comparison) {
  const payload = { exported_at: new Date().toISOString(), latest, previous, comparison }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `greek-analysis-${Date.now()}.json`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}
