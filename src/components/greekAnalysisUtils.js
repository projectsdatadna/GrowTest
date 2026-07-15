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

const GREEK_REASON = {
  delta: (change) => (change > 0 ? 'Bullish delta shift' : 'Bearish delta shift'),
  gamma: (change) => (change > 0 ? 'Gamma acceleration' : 'Gamma deceleration'),
  theta: (change) => (change < 0 ? 'Time decay increasing' : 'Time decay easing'),
  vega: (change) => (change > 0 ? 'IV expansion' : 'IV contraction'),
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
    return {
      key,
      label: key[0].toUpperCase() + key.slice(1),
      avgChange,
      pctChange,
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
