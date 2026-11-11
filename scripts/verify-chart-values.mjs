/**
 * Validates what the Notifications hover chart and cards show, against the data
 * behind them. Read-only. Needs Firestore credentials (like the other scripts)
 * and a running API:
 *
 *   node scripts/verify-chart-values.mjs [--url http://localhost:5055] [--per 8]
 *
 * For a sample of cards across every timeframe it checks: the crossover bar is
 * in the chart candles and the close matches the card; every indicator's
 * crossover marker exists at that bar, has the card's direction and line values,
 * and the plotted lines really cross there (previous bar on one side, this bar
 * on the other); the ADX column matches the plotted ADX series and the
 * +/-0.5 rule; stars / counts / labels; the underlying notifications agree;
 * isIndex / sortOrder match the symbol document. Then section totals vs list
 * totals with and without the ADX filter.
 */

import { scannerDb as db, SCANNER_COLLECTIONS } from '../functions/crossoverScannerFirestoreClient.js'
import { CROSSOVER_SPECS } from '../functions/crossoverScanner.js'
import { candleEnd, TIMEFRAME_ORDER } from '../functions/crossoverTimeframes.js'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 ? process.argv[i + 1] : fallback
}
const BASE = arg('url', 'http://localhost:5055').replace(/\/$/, '')
const PER_SECTION = Number(arg('per', 8))

let failures = 0
let checks = 0
const problems = []
function check(ok, message) {
  checks++
  if (!ok) {
    failures++
    problems.push(message)
  }
}
// Drift: the card was computed from the bars Groww had published ~2 minutes after
// the close; Groww revises recent bars afterwards and the scanner re-fetches them,
// so the chart (current stored bars) can differ slightly from the card. Reported
// separately - it is upstream data revision, not a logic error.
const drifts = []
function drift(ok, message) {
  if (!ok) drifts.push(message)
}
const near = (a, b, tol = 0.011) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tol
const get = async (path) => {
  const response = await fetch(`${BASE}${path}`)
  return { status: response.status, body: await response.json().catch(() => null) }
}

// crossover spec -> [plain series key, fieldA, fieldB]: "A crosses above B" is bullish.
function pairFor(spec) {
  const [name, ...p] = spec.split(':')
  switch (name) {
    case 'MACDCROSS': return { key: `MACD:${p.join(':')}`, a: (v) => v.macd, b: (v) => v.signal }
    case 'TSICROSS': return { key: `TSI:${p.join(':')}`, a: (v) => v.tsi, b: (v) => v.signal }
    case 'STOCHRSICROSS': return { key: `STOCHRSI:${p.join(':')}`, a: (v) => v.k, b: (v) => v.d }
    case 'DMICROSS': return { key: `ADX:${p[0]}`, a: (v) => v.pdi, b: (v) => v.mdi }
    default: return null // RSI / SMA / EMA are checked from two plain series below
  }
}
const at = (points, ts) => points.find((x) => x.timestamp === ts)
const before = (points, ts) => {
  const i = points.findIndex((x) => x.timestamp === ts)
  return i > 0 ? points[i - 1] : null
}
const sign = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0)

function lineValues(spec, series, ts) {
  // returns {a:{prev,now}, b:{prev,now}} from the plotted series
  const [name, ...p] = spec.split(':')
  const pick = (points, f) => ({ prev: before(points, ts) ? f(before(points, ts).value) : null, now: at(points, ts) ? f(at(points, ts).value) : null })
  const pair = pairFor(spec)
  if (pair) {
    const pts = series[pair.key] || []
    return { a: pick(pts, pair.a), b: pick(pts, pair.b) }
  }
  if (name === 'RSICROSS') return { a: pick(series[`RSI:${p[0]}`] || [], (v) => v), b: pick(series[`RSIMA:${p[0]}:${p[1]}`] || [], (v) => v) }
  if (name === 'SMACROSS') return { a: pick(series[`SMA:${p[0]}`] || [], (v) => v), b: pick(series[`SMA:${p[1]}`] || [], (v) => v) }
  if (name === 'EMACROSS') return { a: pick(series[`EMA:${p[0]}`] || [], (v) => v), b: pick(series[`EMA:${p[1]}`] || [], (v) => v) }
  return null
}

const specDef = new Map(CROSSOVER_SPECS.map((d) => [d.spec, d]))
const crossKey = (spec) => (spec.startsWith('DMICROSS:') ? `ADXCROSS:${spec.split(':')[1]}` : spec)

async function verifyGroup(group, stats) {
  const where = `${group.symbol} ${group.interval} @${group.candleTimestamp}`
  const { status, body } = await get(`/notifications/groups/${encodeURIComponent(group.id)}/chart`)
  if (status === 404) {
    stats.unavailable++
    return
  }
  check(status === 200 && body?.status === 'SUCCESS', `${where}: chart endpoint HTTP ${status}`)
  if (status !== 200) return
  stats.charted++
  const ts = group.candleTimestamp
  const candle = at(body.candles, ts)
  check(Boolean(candle), `${where}: crossover bar missing from chart candles`)
  if (candle) drift(near(candle.close, group.closePrice), `${where}: card close ${group.closePrice} != chart candle close ${candle.close}`)
  check(body.crossoverEnd === candleEnd(group.interval, ts), `${where}: crossover end mismatch`)
  check(body.candles.every((c, i, a) => i === 0 || c.timestamp > a[i - 1].timestamp), `${where}: candles not strictly ascending`)

  for (const indicator of group.indicators) {
    const label = `${where} ${indicator.label}`
    const events = body.series[crossKey(indicator.spec)] || []
    const event = events.find((e) => e.timestamp === ts)
    drift(Boolean(event), `${label}: crossover no longer reproduced at the card's bar with current stored bars`)
    if (!event) continue
    check(event.value.type === indicator.direction, `${label}: marker ${event.value.type} != card ${indicator.direction}`)
    const def = specDef.get(indicator.spec)
    for (const [key, name] of Object.entries(def.lineNames)) {
      drift(near(event.value[key], indicator.lines?.[name]), `${label}: ${name} marker ${event.value[key]} != card ${indicator.lines?.[name]}`)
    }
    // The plotted lines must really cross at this bar.
    const lines = lineValues(indicator.spec, body.series, ts)
    if (lines && lines.a.now != null && lines.a.prev != null && lines.b.now != null && lines.b.prev != null) {
      const prev = sign(lines.a.prev - lines.b.prev)
      const now = sign(lines.a.now - lines.b.now)
      const bullish = indicator.direction === 'bullish'
      check(bullish ? prev <= 0 && now > 0 : prev >= 0 && now < 0, `${label}: plotted lines do not cross ${indicator.direction} at the bar (prev diff ${(lines.a.prev - lines.b.prev).toFixed(3)}, now ${(lines.a.now - lines.b.now).toFixed(3)})`)
    } else if (lines) {
      stats.noWarmup++
    }
  }

  // ADX column vs the plotted ADX series.
  const adxPoints = body.series['ADX:14'] || []
  const adxNow = at(adxPoints, ts)?.value?.adx
  const adxPrev = before(adxPoints, ts)?.value?.adx
  if (group.adx) {
    drift(near(adxNow, group.adx.value), `${where}: ADX now card ${group.adx.value} != chart ${adxNow}`)
    drift(near(adxPrev, group.adx.prev), `${where}: ADX prev card ${group.adx.prev} != chart ${adxPrev}`)
    const delta = group.adx.value - group.adx.prev
    const trend = delta > 0.5 ? 'increase' : delta < -0.5 ? 'decrease' : 'flat'
    check(group.adx.trend === trend, `${where}: ADX status ${group.adx.trend} but delta ${delta.toFixed(2)} gives ${trend}`)
    check(group.adxTrend === group.adx.trend, `${where}: adxTrend field ${group.adxTrend} != ${group.adx.trend}`)
  } else {
    stats.noAdx++
  }

  // Card arithmetic.
  const labels = new Set(group.indicators.map((i) => i.label))
  const bull = group.indicators.filter((i) => i.direction === 'bullish').length
  check(group.stars === labels.size, `${where}: stars ${group.stars} != distinct indicators ${labels.size}`)
  check(group.bullishCount === bull && group.bearishCount === group.indicators.length - bull, `${where}: bullish/bearish counts wrong`)
  check(group.hasBullish === bull > 0 && group.hasBearish === group.indicators.length - bull > 0, `${where}: hasBullish/hasBearish wrong`)
  check([...labels].every((l) => group.indicatorLabels.includes(l)) && group.indicatorLabels.length === labels.size, `${where}: indicatorLabels wrong`)

  // The notifications behind the card.
  const refs = group.notificationIds.map((id) => db.collection(SCANNER_COLLECTIONS.notifications).doc(id))
  const docs = await db.getAll(...refs)
  check(docs.length === group.indicators.length, `${where}: ${docs.length} notifications for ${group.indicators.length} indicators`)
  for (const doc of docs) {
    const n = doc.data()
    check(doc.exists, `${where}: notification ${doc.id} missing`)
    if (!doc.exists) continue
    const indicator = group.indicators.find((i) => i.notificationId === doc.id || i.label === n.indicatorLabel)
    check(n.symbol === group.symbol && n.interval === group.interval && n.candleTimestamp === ts, `${where}: notification ${doc.id} symbol/interval/bar differ`)
    check(Boolean(indicator) && n.direction === indicator.direction && n.indicatorLabel === indicator.label, `${where}: notification ${doc.id} direction/label differ`)
    check(near(n.closePrice, group.closePrice), `${where}: notification close ${n.closePrice} != card ${group.closePrice}`)
    for (const [name, value] of Object.entries(n.lines || {})) check(near(value, indicator?.lines?.[name]), `${where}: notification line ${name} differs`)
  }

  // Ordering fields vs the symbol document.
  const symbolDoc = await db.collection(SCANNER_COLLECTIONS.symbols).doc(`${group.exchange}_${group.symbol}`).get()
  if (symbolDoc.exists) {
    const s = symbolDoc.data()
    check(group.sortOrder === s.sortOrder, `${where}: card sortOrder ${group.sortOrder} != symbol ${s.sortOrder}`)
    check(Boolean(group.isIndex) === Boolean(s.isIndex), `${where}: card isIndex ${group.isIndex} != symbol ${s.isIndex}`)
  } else {
    stats.inactiveSymbol++
  }
}

async function main() {
  const stats = { sampled: 0, charted: 0, unavailable: 0, noAdx: 0, noWarmup: 0, inactiveSymbol: 0 }
  for (const section of TIMEFRAME_ORDER) {
    const picked = new Map()
    const first = await get(`/notifications/groups?section=${section}&page=1&pageSize=25`)
    check(first.status === 200, `${section}: groups page 1 HTTP ${first.status}`)
    first.body?.groups?.slice(0, Math.ceil(PER_SECTION / 2)).forEach((g) => picked.set(g.id, g))
    const pages = Math.ceil((first.body?.total || 0) / 25)
    for (const page of [Math.ceil(pages / 2), pages].filter((p) => p > 1)) {
      const r = await get(`/notifications/groups?section=${section}&page=${page}&pageSize=25`)
      const groups = r.body?.groups || []
      groups.sort((a, b) => b.stars - a.stars) // include multi-indicator cards
      groups.slice(0, Math.ceil(PER_SECTION / 4)).forEach((g) => picked.set(g.id, g))
    }
    for (const group of picked.values()) {
      stats.sampled++
      await verifyGroup(group, stats)
    }
  }

  // Section totals: list vs counts under the ADX filter; the three statuses plus
  // cards without ADX add up to the unfiltered card total.
  const unfiltered = {}
  for (const section of TIMEFRAME_ORDER) unfiltered[section] = (await get(`/notifications/groups?section=${section}&pageSize=1`)).body?.total
  for (const adx of ['increase', 'decrease', 'flat']) {
    const counts = (await get(`/notifications/counts?adx=${adx}`)).body?.sections
    for (const section of TIMEFRAME_ORDER) {
      const list = (await get(`/notifications/groups?section=${section}&pageSize=1&adx=${adx}`)).body
      check(counts?.[section]?.total === list?.total, `${section} adx=${adx}: counts total ${counts?.[section]?.total} != list total ${list?.total}`)
      const bull = (await get(`/notifications/groups?section=${section}&pageSize=1&adx=${adx}&direction=bullish`)).body?.total
      check(counts?.[section]?.bullish === bull, `${section} adx=${adx}: counts bullish ${counts?.[section]?.bullish} != list ${bull}`)
    }
  }
  for (const section of TIMEFRAME_ORDER) {
    let sum = 0
    for (const adx of ['increase', 'decrease', 'flat']) sum += (await get(`/notifications/groups?section=${section}&pageSize=1&adx=${adx}`)).body?.total || 0
    const noAdx = unfiltered[section] - sum
    check(noAdx >= 0 && noAdx < 50, `${section}: ${noAdx} cards without ADX (unfiltered ${unfiltered[section]}, by status ${sum})`)
  }

  console.log(`sampled ${stats.sampled} cards: ${stats.charted} charted, ${stats.unavailable} older than stored candles (no chart), ${stats.noAdx} without ADX, ${stats.noWarmup} crossings without enough warm-up bars, ${stats.inactiveSymbol} inactive symbols`)
  console.log(`${checks} checks, ${failures} failed`)
  problems.slice(0, 40).forEach((p) => console.log(`  ✗ ${p}`))
  console.log(`${drifts.length} value drift note(s) (card computed from bars as first published vs current stored bars):`)
  drifts.slice(0, 40).forEach((d) => console.log(`  ~ ${d}`))
  if (stats.charted === 0) {
    console.log('✗ no card could be charted')
    process.exit(1)
  }
  process.exit(failures ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
