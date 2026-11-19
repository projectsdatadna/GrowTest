import test from 'node:test'
import assert from 'node:assert/strict'
import {
  GREEK_INTERPRETATION_CONFIG,
  classifyMagnitude,
  interpretDelta,
  interpretGamma,
  interpretTheta,
  interpretVega,
  interpretRho,
  interpretGreekRow,
  decorateGreekRows,
} from '../greekInterpretation.js'
import { buildOptionChainDiff } from '../optionChainIntervalSnapshots.js'

test('classifyMagnitude: absolute mode (delta) boundaries', () => {
  const cfg = GREEK_INTERPRETATION_CONFIG.delta
  assert.equal(classifyMagnitude({ mode: 'absolute', diff: 0.019, cfg }), 'noise')
  assert.equal(classifyMagnitude({ mode: 'absolute', diff: 0.02, cfg }), 'moderate')
  assert.equal(classifyMagnitude({ mode: 'absolute', diff: 0.049, cfg }), 'moderate')
  assert.equal(classifyMagnitude({ mode: 'absolute', diff: 0.05, cfg }), 'strong')
  assert.equal(classifyMagnitude({ mode: 'absolute', diff: -0.06, cfg }), 'strong')
  assert.equal(classifyMagnitude({ mode: 'absolute', diff: null, cfg }), 'insufficient-data')
})

test('classifyMagnitude: relative mode boundaries', () => {
  const cfg = GREEK_INTERPRETATION_CONFIG.gamma
  assert.equal(classifyMagnitude({ mode: 'relative', prev: 0.01, curr: 0.0109, pct: 9, cfg }), 'noise')
  assert.equal(classifyMagnitude({ mode: 'relative', prev: 0.01, curr: 0.011, pct: 10, cfg }), 'moderate')
  assert.equal(classifyMagnitude({ mode: 'relative', prev: 0.01, curr: 0.0124, pct: 24, cfg }), 'moderate')
  assert.equal(classifyMagnitude({ mode: 'relative', prev: 0.01, curr: 0.0125, pct: 25, cfg }), 'strong')
})

test('classifyMagnitude: relative mode magnitude floor guards near-zero values', () => {
  const cfg = GREEK_INTERPRETATION_CONFIG.gamma // minMagnitude 0.0005
  assert.equal(classifyMagnitude({ mode: 'relative', prev: 0.0001, curr: 0.0004, pct: 300, cfg }), 'insufficient-data')
  // curr clears the floor even though prev doesn't - still trusted
  assert.equal(classifyMagnitude({ mode: 'relative', prev: 0.0001, curr: 0.001, pct: 900, cfg }), 'strong')
  assert.equal(classifyMagnitude({ mode: 'relative', prev: null, curr: 0.001, pct: null, cfg }), 'insufficient-data')
})

test('interpretDelta: CE strengthening/weakening', () => {
  assert.deepEqual(interpretDelta({ side: 'CE', diff: 0.07, significance: 'strong' }), {
    status: 'CALL_SENSITIVITY_STRENGTHENING',
    signal: 'bullish',
    message: 'Call-side directional sensitivity is strengthening.',
  })
  assert.deepEqual(interpretDelta({ side: 'CE', diff: -0.03, significance: 'moderate' }), {
    status: 'CALL_SENSITIVITY_WEAKENING',
    signal: 'bearish',
    message: 'Call-side directional sensitivity is weakening.',
  })
})

test('interpretDelta: PE strengthening/weakening, including a sign-flip edge case', () => {
  // PE delta becomes more negative -> strengthening (downside sensitivity)
  assert.deepEqual(interpretDelta({ side: 'PE', diff: -0.08, significance: 'strong' }), {
    status: 'PUT_SENSITIVITY_STRENGTHENING',
    signal: 'bearish',
    message: 'Put-side downside sensitivity is strengthening.',
  })
  // PE delta moves toward zero -> weakening
  assert.deepEqual(interpretDelta({ side: 'PE', diff: 0.03, significance: 'moderate' }), {
    status: 'PUT_SENSITIVITY_WEAKENING',
    signal: 'bullish',
    message: 'Put-side downside sensitivity is weakening.',
  })
  // Edge case: prev -0.3 -> curr +0.1 is a sign flip; diff = +0.4, still classified by
  // the sign of diff as "moved toward zero" / weakening - no special-casing needed.
  assert.equal(interpretDelta({ side: 'PE', diff: 0.4, significance: 'strong' }).status, 'PUT_SENSITIVITY_WEAKENING')
})

test('interpretDelta: stable below noise threshold, both sides', () => {
  assert.equal(interpretDelta({ side: 'CE', diff: 0.005, significance: 'noise' }).status, 'DELTA_STABLE')
  assert.equal(interpretDelta({ side: 'PE', diff: -0.005, significance: 'noise' }).status, 'DELTA_STABLE')
  assert.equal(interpretDelta({ side: 'CE', diff: null, significance: 'insufficient-data' }).status, 'DELTA_STABLE')
})

test('interpretGamma: rising/falling/stable', () => {
  assert.equal(interpretGamma({ diff: 0.001, significance: 'strong' }).status, 'GAMMA_RISING')
  assert.equal(interpretGamma({ diff: -0.001, significance: 'moderate' }).status, 'GAMMA_FALLING')
  assert.equal(interpretGamma({ diff: 0.00001, significance: 'noise' }).status, 'GAMMA_STABLE')
  assert.equal(interpretGamma({ diff: null, significance: 'insufficient-data' }).status, 'GAMMA_STABLE')
})

test('interpretTheta: pressure rising/falling/stable', () => {
  assert.equal(interpretTheta({ diff: -2, significance: 'strong' }).status, 'THETA_PRESSURE_RISING')
  assert.equal(interpretTheta({ diff: 2, significance: 'moderate' }).status, 'THETA_PRESSURE_FALLING')
  assert.equal(interpretTheta({ diff: 0.01, significance: 'noise' }).status, 'THETA_STABLE')
})

test('interpretVega: rising/falling/stable, magnitude-only (no IV reference)', () => {
  assert.equal(interpretVega({ diff: 0.5, significance: 'strong' }).status, 'VEGA_RISING')
  assert.equal(interpretVega({ diff: -0.5, significance: 'moderate' }).status, 'VEGA_FALLING')
  assert.equal(interpretVega({ diff: 0.001, significance: 'insufficient-data' }).status, 'VEGA_STABLE')
})

test('interpretRho: rising/falling/stable', () => {
  assert.equal(interpretRho({ diff: 0.02, significance: 'strong' }).status, 'RHO_RISING')
  assert.equal(interpretRho({ diff: -0.02, significance: 'moderate' }).status, 'RHO_FALLING')
  assert.equal(interpretRho({ diff: 0, significance: 'noise' }).status, 'RHO_STABLE')
})

test('interpretGreekRow: dispatches by metric name and passes through non-Greek metrics as null', () => {
  const delta = interpretGreekRow({ metric: 'Delta', side: 'CE', prev: 0.45, curr: 0.52, diff: 0.07, pct: 15.6 })
  assert.equal(delta.status, 'CALL_SENSITIVITY_STRENGTHENING')
  assert.equal(delta.significance, 'strong')

  assert.equal(interpretGreekRow({ metric: 'OI', side: 'CE', prev: 100, curr: 110, diff: 10, pct: 10 }), null)
  assert.equal(interpretGreekRow({ metric: 'LTP', side: 'PE', prev: 1, curr: 2, diff: 1, pct: 100 }), null)
  assert.equal(interpretGreekRow({ metric: 'IV', side: 'CE', prev: 10, curr: 11, diff: 1, pct: 10 }), null)
})

test('decorateGreekRows: Greek rows gain interpretation fields, others pass through unchanged', () => {
  const rows = [
    { strike: 100, side: 'CE', metric: 'OI', prev: 1000, curr: 940, diff: -60, pct: -6, flag: true },
    { strike: 100, side: 'CE', metric: 'Delta', prev: 0.45, curr: 0.52, diff: 0.07, pct: 15.56, flag: true },
    { strike: 100, side: 'PE', metric: 'Gamma', prev: 0.0001, curr: 0.0004, diff: 0.0003, pct: 300, flag: true },
  ]
  const decorated = decorateGreekRows(rows)
  assert.deepEqual(decorated[0], rows[0])
  assert.equal(decorated[1].status, 'CALL_SENSITIVITY_STRENGTHENING')
  assert.equal(decorated[1].significance, 'strong')
  assert.equal(decorated[1].prev, 0.45)
  // near-zero gamma magnitudes are guarded by the minMagnitude floor
  assert.equal(decorated[2].significance, 'insufficient-data')
  assert.equal(decorated[2].status, 'GAMMA_STABLE')
})

test('composition: buildOptionChainDiff -> decorateGreekRows end to end', () => {
  const prev = { strikes: [{ strike: 100, ce: { ltp: 10, oi: 1000, iv: 20, delta: 0.45, gamma: 0.002, theta: -10, vega: 5, rho: 0.1 }, pe: null }] }
  const curr = { strikes: [{ strike: 100, ce: { ltp: 10.5, oi: 940, iv: 21, delta: 0.52, gamma: 0.0016, theta: -12, vega: 4, rho: 0.1 }, pe: null }] }
  const decorated = decorateGreekRows(buildOptionChainDiff(prev, curr))
  const find = (metric) => decorated.find((r) => r.side === 'CE' && r.metric === metric)

  assert.equal(find('OI').status, undefined) // untouched
  const delta = find('Delta')
  assert.equal(delta.status, 'CALL_SENSITIVITY_STRENGTHENING')
  assert.equal(delta.diff, 0.07)
  const theta = find('Theta')
  assert.equal(theta.status, 'THETA_PRESSURE_RISING') // -12 more negative than -10
  const vega = find('Vega')
  assert.equal(vega.status, 'VEGA_FALLING')
})
