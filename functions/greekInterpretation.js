/**
 * Individual-contract Greek interpretation: classifies the significance of a
 * Delta/Gamma/Theta/Vega/Rho change (from an `optionChainIntervalSnapshots.js`
 * diff row) and attaches a sign-aware status and plain-English message.
 *
 * Scope: one contract (strike x side), one Greek, one timeframe comparison -
 * no chain-wide aggregation, no multi-timeframe alignment, no combined-Greek
 * rules, no AI. Pure functions only, mirroring the pure-helpers style of
 * optionChainIntervalSnapshots.js so this is trivially unit-testable.
 */

// minMagnitude values are starting placeholders, not derived from real data.
// TODO: calibrate against real snapshot distributions once enough history exists.
export const GREEK_INTERPRETATION_CONFIG = {
  delta: { mode: 'absolute', noise: 0.02, strong: 0.05 },
  gamma: { mode: 'relative', noise: 10, strong: 25, minMagnitude: 0.0005 },
  theta: { mode: 'relative', noise: 10, strong: 25, minMagnitude: 0.05 },
  vega: { mode: 'relative', noise: 10, strong: 25, minMagnitude: 0.01 },
  rho: { mode: 'relative', noise: 10, strong: 25, minMagnitude: 0.01 },
}

/** Classifies the size of a change as noise / moderate / strong / insufficient-data. */
export function classifyMagnitude({ mode, prev, curr, diff, pct, cfg }) {
  if (mode === 'absolute') {
    if (diff == null) return 'insufficient-data'
    const abs = Math.abs(diff)
    if (abs >= cfg.strong) return 'strong'
    if (abs >= cfg.noise) return 'moderate'
    return 'noise'
  }
  // relative
  const tooSmall = prev == null || (Math.abs(prev) < cfg.minMagnitude && Math.abs(curr ?? 0) < cfg.minMagnitude)
  if (tooSmall || pct == null) return 'insufficient-data'
  const abs = Math.abs(pct)
  if (abs >= cfg.strong) return 'strong'
  if (abs >= cfg.noise) return 'moderate'
  return 'noise'
}

const isFlat = (significance) => significance === 'noise' || significance === 'insufficient-data'

export function interpretDelta({ side, diff, significance }) {
  if (isFlat(significance) || diff == null) {
    return { status: 'DELTA_STABLE', signal: 'neutral', message: 'Directional sensitivity remains relatively stable.' }
  }
  if (side === 'CE') {
    return diff > 0
      ? { status: 'CALL_SENSITIVITY_STRENGTHENING', signal: 'bullish', message: 'Call-side directional sensitivity is strengthening.' }
      : { status: 'CALL_SENSITIVITY_WEAKENING', signal: 'bearish', message: 'Call-side directional sensitivity is weakening.' }
  }
  return diff < 0
    ? { status: 'PUT_SENSITIVITY_STRENGTHENING', signal: 'bearish', message: 'Put-side downside sensitivity is strengthening.' }
    : { status: 'PUT_SENSITIVITY_WEAKENING', signal: 'bullish', message: 'Put-side downside sensitivity is weakening.' }
}

export function interpretGamma({ diff, significance }) {
  if (isFlat(significance) || diff == null) {
    return { status: 'GAMMA_STABLE', signal: 'neutral', message: 'Gamma conditions remain relatively unchanged.' }
  }
  return diff > 0
    ? { status: 'GAMMA_RISING', signal: 'bullish', message: 'Delta may change more rapidly as the underlying moves.' }
    : { status: 'GAMMA_FALLING', signal: 'bearish', message: 'Delta is becoming less sensitive to underlying movements.' }
}

export function interpretTheta({ diff, significance }) {
  if (isFlat(significance) || diff == null) {
    return { status: 'THETA_STABLE', signal: 'neutral', message: 'Time-decay pressure remains relatively unchanged.' }
  }
  return diff < 0
    ? { status: 'THETA_PRESSURE_RISING', signal: 'bearish', message: 'Time-decay pressure is increasing.' }
    : { status: 'THETA_PRESSURE_FALLING', signal: 'bullish', message: 'Time-decay pressure is reducing.' }
}

export function interpretVega({ diff, significance }) {
  if (isFlat(significance) || diff == null) {
    return { status: 'VEGA_STABLE', signal: 'neutral', message: 'Volatility sensitivity remains relatively unchanged.' }
  }
  return diff > 0
    ? { status: 'VEGA_RISING', signal: 'bullish', message: 'Options are becoming more sensitive to volatility changes.' }
    : { status: 'VEGA_FALLING', signal: 'bearish', message: 'Options are becoming less sensitive to volatility changes.' }
}

export function interpretRho({ diff, significance }) {
  if (isFlat(significance) || diff == null) {
    return { status: 'RHO_STABLE', signal: 'neutral', message: 'Interest-rate sensitivity remains relatively unchanged.' }
  }
  return diff > 0
    ? { status: 'RHO_RISING', signal: 'bullish', message: 'Interest-rate sensitivity is increasing.' }
    : { status: 'RHO_FALLING', signal: 'bearish', message: 'Interest-rate sensitivity is reducing.' }
}

const GREEK_RULES = {
  Delta: { key: 'delta', interpret: interpretDelta },
  Gamma: { key: 'gamma', interpret: interpretGamma },
  Theta: { key: 'theta', interpret: interpretTheta },
  Vega: { key: 'vega', interpret: interpretVega },
  Rho: { key: 'rho', interpret: interpretRho },
}

/** For a Delta/Gamma/Theta/Vega/Rho diff row, returns {status, signal, message, significance}; null for other metrics. */
export function interpretGreekRow({ metric, side, prev, curr, diff, pct }) {
  const rule = GREEK_RULES[metric]
  if (!rule) return null
  const cfg = GREEK_INTERPRETATION_CONFIG[rule.key]
  const significance = classifyMagnitude({ mode: cfg.mode, prev, curr, diff, pct, cfg })
  return { ...rule.interpret({ side, diff, significance }), significance }
}

/** Decorates Delta/Gamma/Theta/Vega/Rho rows from buildOptionChainDiff() with interpretation fields; other rows pass through unchanged. */
export function decorateGreekRows(rows) {
  return rows.map((row) => {
    const interpretation = interpretGreekRow(row)
    return interpretation ? { ...row, ...interpretation } : row
  })
}
