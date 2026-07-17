/**
 * Deterministic Market Pulse scoring - real math from the live option chain
 * (OI, Greeks, volume, PCR, Max Pain), computed entirely client-side. No AI
 * call is involved in these six scores (unlike the sentiment/strategy/etc.
 * fields, which remain AI-generated separately).
 */

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function median(values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function mad(values, med) {
  return median(values.map((v) => Math.abs(v - med)))
}

// Median-absolute-deviation z-score: robust to a single outlier strike
// blowing out the reference scale (unlike a mean/stdev z-score). Falls back
// to neutral (0) when there aren't enough samples or no spread to compare against.
function robustZ(value, allValues, cap = 3) {
  if (allValues.length < 4) return 0
  const med = median(allValues)
  const deviation = mad(allValues, med)
  if (deviation === 0) return 0
  return clamp((value - med) / (1.4826 * deviation), -cap, cap)
}

// 50-centered, direction matters.
function zToSignedScore(z, cap = 3) {
  return clamp(50 + (50 / cap) * z, 0, 100)
}

// Ratio naturally in roughly [-1, 1] -> 0-100 around a neutral 50.
function ratioToScore(ratio) {
  return clamp(50 + 50 * clamp(ratio, -1, 1), 0, 100)
}

// Fit through the spec's own worked examples: IV=10 -> 20, IV=30 -> 60, IV=60 -> ~90.
function ivToScore(iv) {
  if (!iv || iv <= 0) return 50
  return clamp(36.4 * Math.log(iv) - 63.9, 0, 100)
}

function pcrToScore(pcrRaw) {
  return clamp(50 + 25 * Math.log(clamp(pcrRaw, 0.1, 10)), 0, 100)
}

function averageOf(values) {
  const valid = values.filter((v) => typeof v === 'number' && v > 0)
  return valid.length > 0 ? valid.reduce((a, b) => a + b, 0) / valid.length : null
}

function atmWeightedAverage(rows, weights, scoreFn) {
  let sumWeighted = 0
  let sumWeights = 0
  rows.forEach((row, i) => {
    const score = scoreFn(row, i)
    if (typeof score !== 'number' || Number.isNaN(score)) return
    sumWeighted += score * weights[i]
    sumWeights += weights[i]
  })
  return sumWeights > 0 ? sumWeighted / sumWeights : null
}

function parseStrikeRows(filteredStrikes) {
  return Object.entries(filteredStrikes || {})
    .map(([strikeKey, data]) => ({ strike: parseFloat(strikeKey), CE: data?.CE || {}, PE: data?.PE || {} }))
    .filter((row) => Number.isFinite(row.strike))
    .sort((a, b) => a.strike - b.strike)
}

// Robust to one missing strike in the response: the interval is the median
// gap between adjacent strikes, not just the first gap found.
function inferStrikeInterval(rows) {
  if (rows.length < 2) return null
  const diffs = []
  for (let i = 1; i < rows.length; i++) diffs.push(rows[i].strike - rows[i - 1].strike)
  return median(diffs)
}

function findAtmStrike(rows, underlyingLtp) {
  let best = null
  let bestDistance = Infinity
  rows.forEach((row) => {
    const distance = Math.abs(row.strike - underlyingLtp)
    if (distance < bestDistance) {
      bestDistance = distance
      best = row.strike
    }
  })
  return best
}

function strikeWeight(distanceInStrikes) {
  if (distanceInStrikes === 0) return 1.0
  if (distanceInStrikes === 1) return 0.9
  if (distanceInStrikes === 2) return 0.8
  if (distanceInStrikes === 3) return 0.6
  return 0.3
}

export function isSameInstrument(a, b) {
  return a.underlying_symbol === b.underlying_symbol && a.expiry_date === b.expiry_date && a.exchange === b.exchange
}

function buildPreviousLookup(previousRows) {
  const map = new Map()
  previousRows.forEach((row) => map.set(row.strike, row))
  return map
}

// Combines each strike's current data with its matching previous-snapshot
// leg (when one exists), so downstream formulas can read `ceChg`/`peChg`
// etc. directly instead of re-deriving them everywhere.
function enrichRow(row, previousLookup) {
  const prevRow = previousLookup ? previousLookup.get(row.strike) : null
  const ceOi = row.CE.open_interest || 0
  const peOi = row.PE.open_interest || 0
  const ceVol = row.CE.volume || 0
  const peVol = row.PE.volume || 0
  const ceG = row.CE.greeks || {}
  const peG = row.PE.greeks || {}
  const avgIv = averageOf([ceG.iv, peG.iv])

  const hasPrevious = Boolean(prevRow)
  const prevCeOi = prevRow?.CE?.open_interest || 0
  const prevPeOi = prevRow?.PE?.open_interest || 0
  const prevCeVol = prevRow?.CE?.volume || 0
  const prevPeVol = prevRow?.PE?.volume || 0
  const prevAvgIv = hasPrevious ? averageOf([prevRow.CE?.greeks?.iv, prevRow.PE?.greeks?.iv]) : null

  return {
    strike: row.strike,
    ceOi,
    peOi,
    ceVol,
    peVol,
    ceG,
    peG,
    avgIv,
    hasPrevious,
    ceChg: hasPrevious ? ceOi - prevCeOi : 0,
    peChg: hasPrevious ? peOi - prevPeOi : 0,
    ceVolChg: hasPrevious ? ceVol - prevCeVol : 0,
    peVolChg: hasPrevious ? peVol - prevPeVol : 0,
    prevCeOi,
    prevPeOi,
    prevAvgIv,
  }
}

function computeChainPcr(rows) {
  let totalCallOi = 0
  let totalPutOi = 0
  rows.forEach((row) => {
    totalCallOi += row.CE.open_interest || 0
    totalPutOi += row.PE.open_interest || 0
  })
  const raw = totalCallOi > 0 ? totalPutOi / totalCallOi : totalPutOi > 0 ? 5 : 1
  return { raw, totalCallOi, totalPutOi }
}

/**
 * Standard "minimize total option-writer payout" Max Pain algorithm.
 *
 * Caveat: this only considers the strikes already fetched (the ±points_range
 * window the backend filters to) - both the candidate settlement prices and
 * the OI summed are restricted to that band. A small points_range can
 * produce a different Max Pain than the true full-chain figure, since OI
 * sitting outside the window is invisible here. Fixing that would require
 * the backend to stop discarding out-of-range strikes - out of scope.
 */
export function computeMaxPain(rows) {
  if (rows.length === 0) return null
  let bestStrike = null
  let bestPayout = Infinity
  rows.forEach(({ strike: settlePrice }) => {
    let payout = 0
    rows.forEach((row) => {
      const ceOi = row.CE.open_interest || 0
      const peOi = row.PE.open_interest || 0
      if (settlePrice > row.strike) payout += ceOi * (settlePrice - row.strike)
      if (settlePrice < row.strike) payout += peOi * (row.strike - settlePrice)
    })
    if (payout < bestPayout) {
      bestPayout = payout
      bestStrike = settlePrice
    }
  })
  return bestStrike
}

/**
 * Computes the six Market Pulse scores (plus PCR/Max Pain/ATM as extra
 * fields) from the latest snapshot and, where available, the previous one.
 * Returns null only if there are no strikes to score at all.
 */
export function computeMarketPulse(latest, previous) {
  const latestRows = parseStrikeRows(latest?.filtered_strikes)
  if (latestRows.length === 0) return null

  const previousRows = previous ? parseStrikeRows(previous.filtered_strikes) : []
  // Treat a previous snapshot of a *different* instrument (form edited and
  // resubmitted without hitting "Clear") the same as "no previous snapshot" -
  // diffing OI across two different instruments would be meaningless.
  const hasPreviousSnapshot = Boolean(previous) && isSameInstrument(latest, previous) && previousRows.length > 0
  const previousLookup = hasPreviousSnapshot ? buildPreviousLookup(previousRows) : null

  const rows = latestRows.map((row) => enrichRow(row, previousLookup))

  const interval = inferStrikeInterval(latestRows)
  const atmStrike = findAtmStrike(latestRows, latest.underlying_ltp)
  const weights = rows.map((row) => strikeWeight(interval ? Math.round(Math.abs(row.strike - atmStrike) / interval) : 0))

  const gammaTotals = rows.map((r) => (r.ceG.gamma || 0) + (r.peG.gamma || 0))
  const vegaTotals = rows.map((r) => (r.ceG.vega || 0) + (r.peG.vega || 0))
  const volumeTotals = rows.map((r) => r.ceVol + r.peVol)
  const absThetaTotals = rows.map((r) => (Math.abs(r.ceG.theta || 0) + Math.abs(r.peG.theta || 0)) / 2)
  const oiChangeMagnitudes = rows.map((r) => Math.abs(r.ceChg) + Math.abs(r.peChg))

  const pcrCurrent = computeChainPcr(latestRows)
  const maxPainCurrent = computeMaxPain(latestRows)

  // --- Price Strength: 40% OI Build-up + 30% PCR + 20% Delta + 10% Gamma ---
  const priceStrengthStrikeAvg = atmWeightedAverage(rows, weights, (row, i) => {
    const netBuildupRatio = row.hasPrevious
      ? (row.peChg - row.ceChg) / Math.max(1, row.ceOi + row.peOi)
      : (row.peOi - row.ceOi) / Math.max(1, row.ceOi + row.peOi)
    const oiBuildScore = ratioToScore(netBuildupRatio)
    const deltaScore = ratioToScore((row.ceG.delta || 0) + (row.peG.delta || 0))
    const gammaScore = zToSignedScore(robustZ(gammaTotals[i], gammaTotals))
    // Rescale the 0.7 strike-level share (OI-build+delta+gamma) back to 0-1
    // before blending with the chain-level PCR term (0.3).
    return (0.4 * oiBuildScore + 0.2 * deltaScore + 0.1 * gammaScore) / 0.7
  })
  const price_strength =
    priceStrengthStrikeAvg == null ? null : clamp(0.7 * priceStrengthStrikeAvg + 0.3 * pcrToScore(pcrCurrent.raw), 0, 100)

  // --- Momentum: 35% Delta + 20% Gamma + 25% Volume + 20% OI Change ---
  const momentum = atmWeightedAverage(rows, weights, (row, i) => {
    const deltaMomentum = clamp(((Math.abs(row.ceG.delta || 0) + Math.abs(row.peG.delta || 0)) / 2) * 100, 0, 100)
    const gammaMomentum = zToSignedScore(robustZ(gammaTotals[i], gammaTotals))
    const volumeMomentum = zToSignedScore(robustZ(volumeTotals[i], volumeTotals))
    if (!hasPreviousSnapshot) {
      return (0.35 * deltaMomentum + 0.2 * gammaMomentum + 0.25 * volumeMomentum) / 0.8
    }
    const oiChangeMomentum = zToSignedScore(robustZ(oiChangeMagnitudes[i], oiChangeMagnitudes))
    return 0.35 * deltaMomentum + 0.2 * gammaMomentum + 0.25 * volumeMomentum + 0.2 * oiChangeMomentum
  })

  // --- Volatility: 70% IV + 30% Vega --- (never degrades - no previous-snapshot dependency)
  const volatility_score = atmWeightedAverage(rows, weights, (row, i) => {
    const ivScore = row.avgIv != null ? ivToScore(row.avgIv) : 50
    const vegaScore = zToSignedScore(robustZ(vegaTotals[i], vegaTotals))
    return 0.7 * ivScore + 0.3 * vegaScore
  })

  // --- Buying Pressure: 40% Volume Ratio + 30% OI Increase + 30% Delta ---
  const buying_pressure = atmWeightedAverage(rows, weights, (row) => {
    const volumeRatioScore = ratioToScore((row.ceVol - row.peVol) / Math.max(1, row.ceVol + row.peVol))
    const deltaScore = ratioToScore((row.ceG.delta || 0) + (row.peG.delta || 0))
    if (!row.hasPrevious) {
      return (0.4 * volumeRatioScore + 0.3 * deltaScore) / 0.7
    }
    const oiIncreaseScore = ratioToScore(clamp(row.ceChg / Math.max(1, row.ceOi), -1, 1))
    return 0.4 * volumeRatioScore + 0.3 * oiIncreaseScore + 0.3 * deltaScore
  })

  // --- Selling Pressure: 40% Call Writing + 30% Theta + 20% IV Crush + 10% OI Increase ---
  const selling_pressure = atmWeightedAverage(rows, weights, (row, i) => {
    const callWritingScore = row.hasPrevious
      ? ratioToScore(clamp(row.ceChg / Math.max(1, row.ceOi), -1, 1))
      : ratioToScore((row.ceOi - row.peOi) / Math.max(1, row.ceOi + row.peOi))
    const thetaScore = zToSignedScore(robustZ(absThetaTotals[i], absThetaTotals))
    if (!row.hasPrevious) {
      return (0.4 * callWritingScore + 0.3 * thetaScore) / 0.7
    }
    const ivCrushScore = row.prevAvgIv && row.avgIv != null ? ratioToScore((row.prevAvgIv - row.avgIv) / row.prevAvgIv) : 50
    const oiIncreaseScore = ratioToScore(clamp((row.ceChg + row.peChg) / Math.max(1, row.ceOi + row.peOi), -1, 1))
    return 0.4 * callWritingScore + 0.3 * thetaScore + 0.2 * ivCrushScore + 0.1 * oiIncreaseScore
  })

  // --- Institutional Activity: chain-level, not ATM-weighted (its inputs
  // are whole-window aggregates, not per-strike attributes). Genuinely
  // cannot be computed without a previous snapshot - 4 of its 5 inputs are
  // definitionally change-detection signals with no honest single-snapshot
  // analog, so return null rather than a partially-supported number.
  let institutional_activity = null
  if (hasPreviousSnapshot) {
    const legPctChanges = []
    const volumeDeltas = []
    const oiChangeMagnitudesForBlock = []
    rows.forEach((row) => {
      legPctChanges.push(row.prevCeOi > 0 ? row.ceChg / row.prevCeOi : row.ceOi > 0 ? 1 : 0)
      legPctChanges.push(row.prevPeOi > 0 ? row.peChg / row.prevPeOi : row.peOi > 0 ? 1 : 0)
      volumeDeltas.push(row.ceVolChg, row.peVolChg)
      oiChangeMagnitudesForBlock.push(Math.abs(row.ceChg), Math.abs(row.peChg))
    })

    const spikeFraction = legPctChanges.filter((p) => Math.abs(p) > 0.1).length / Math.max(1, legPctChanges.length)
    const largeOiBuildupScore = clamp((100 * spikeFraction) / 0.4, 0, 100)

    const maxVolumeZ = Math.max(0, ...volumeDeltas.map((d) => robustZ(d, volumeDeltas)))
    const volumeSpikeScore = clamp(maxVolumeZ * 33.3, 0, 100)

    const pcrPrevious = computeChainPcr(previousRows)
    const pcrShiftMagnitude = clamp(Math.abs(pcrCurrent.raw - pcrPrevious.raw) * 500, 0, 100)

    const maxPainPrevious = computeMaxPain(previousRows)
    const maxPainShiftMagnitude =
      maxPainCurrent != null && maxPainPrevious != null && interval
        ? clamp((Math.abs(maxPainCurrent - maxPainPrevious) / interval) * 100, 0, 100)
        : 0

    const largestAbsOiChange = Math.max(0, ...oiChangeMagnitudesForBlock)
    const blockOiScore = clamp(Math.max(0, robustZ(largestAbsOiChange, oiChangeMagnitudesForBlock)) * 33.3, 0, 100)

    institutional_activity = clamp(
      0.25 * largeOiBuildupScore + 0.25 * volumeSpikeScore + 0.2 * pcrShiftMagnitude + 0.15 * maxPainShiftMagnitude + 0.15 * blockOiScore,
      0,
      100
    )
  }

  return {
    price_strength,
    momentum,
    volatility_score,
    buying_pressure,
    selling_pressure,
    institutional_activity,
    pcr: pcrCurrent.raw,
    maxPainStrike: maxPainCurrent,
    atmStrike,
  }
}
