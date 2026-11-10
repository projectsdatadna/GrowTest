/**
 * One-off: fills the `adx` field (ADX(14) at the crossover bar vs the bar
 * before) on crossover groups created before the scanner recorded it, using
 * the cached candle windows (scannerCandleWindows). Only the `adx` field is
 * written, and groups that already have it are skipped, so it is safe to
 * re-run. Cards whose bar is older than the cached candles stay without ADX.
 *
 *   node functions/scripts/backfillGroupAdx.mjs           # dry run
 *   node functions/scripts/backfillGroupAdx.mjs --apply
 */

import { scannerDb as db, SCANNER_COLLECTIONS } from '../crossoverScannerFirestoreClient.js'
import { computeAdxTrend } from '../adxTrendIndicator.js'

const APPLY = process.argv.includes('--apply')
const BATCH = 400
const WARMUP_BARS = 60 // ADX needs history to settle; earlier bars are unreliable

async function main() {
  const groups = await db.collection(SCANNER_COLLECTIONS.groups).get()
  const pending = new Map() // window id -> [{ref, candleTimestamp}]
  let alreadyHave = 0
  const trendOnly = [] // groups with adx but no top-level adxTrend yet (ADX-status filter)
  for (const doc of groups.docs) {
    const g = doc.data()
    if (g.adx) {
      alreadyHave++
      if (g.adx.trend && g.adxTrend !== g.adx.trend) trendOnly.push({ ref: doc.ref, adxTrend: g.adx.trend })
      continue
    }
    const key = `${g.exchange}_${g.symbol}_${g.interval}`
    if (!pending.has(key)) pending.set(key, [])
    pending.get(key).push({ ref: doc.ref, candleTimestamp: g.candleTimestamp })
  }

  const updates = []
  let missing = 0
  for (const [key, items] of pending) {
    const window = (await db.collection('scannerCandleWindows').doc(key).get()).data()
    if (!window?.t?.length) {
      missing += items.length
      continue
    }
    const candles = window.t.map((t, i) => ({ timestamp: t, open: window.o[i], high: window.h[i], low: window.l[i], close: window.c[i] }))
    const trend = computeAdxTrend(candles)
    const indexOf = new Map(window.t.map((t, i) => [t, i]))
    for (const { ref, candleTimestamp } of items) {
      const adx = trend.get(candleTimestamp)
      if (adx && indexOf.get(candleTimestamp) >= WARMUP_BARS) updates.push({ ref, adx, adxTrend: adx.trend })
      else missing++
    }
  }

  console.log(`${groups.size} groups: ${alreadyHave} already have ADX, ${APPLY ? 'writing' : 'would write'} ${updates.length}, ${missing} stay without (bar older than cached candles); ${APPLY ? 'setting' : 'would set'} adxTrend on ${trendOnly.length} more.`)
  if (!APPLY) return console.log('Dry run - re-run with --apply to write.')
  for (let i = 0; i < updates.length; i += BATCH) {
    const batch = db.batch()
    updates.slice(i, i + BATCH).forEach(({ ref, adx, adxTrend }) => batch.update(ref, { adx, adxTrend }))
    await batch.commit()
  }
  for (let i = 0; i < trendOnly.length; i += BATCH) {
    const batch = db.batch()
    trendOnly.slice(i, i + BATCH).forEach(({ ref, adxTrend }) => batch.update(ref, { adxTrend }))
    await batch.commit()
  }
  console.log('Done.')
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error)
  process.exit(1)
})
