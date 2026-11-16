/**
 * One-off: fills prevClose / dayChange / dayChangePct on existing crossover
 * groups from the stored 1day candle windows. Groups that already have a
 * dayChange are skipped, so it is safe to re-run.
 *
 *   node functions/scripts/backfillDayChange.mjs           # dry run
 *   node functions/scripts/backfillDayChange.mjs --apply
 */

import { scannerDb as db, SCANNER_COLLECTIONS } from '../crossoverScannerFirestoreClient.js'
import { readCandleWindow } from '../crossoverCandleWindow.js'
import { computeDayChange } from '../crossoverDayChange.js'

const APPLY = process.argv.includes('--apply')
const BATCH = 400

async function main() {
  const groups = await db.collection(SCANNER_COLLECTIONS.groups).get()
  const windows = new Map()
  const dailyFor = async (exchange, symbol) => {
    const key = `${exchange}_${symbol}`
    if (!windows.has(key)) windows.set(key, await readCandleWindow({ exchange, symbol, interval: '1day' }).catch(() => []))
    return windows.get(key)
  }

  const writes = []
  let skipped = 0
  let unresolved = 0
  for (const doc of groups.docs) {
    const g = doc.data()
    if (g.dayChange != null) { skipped++; continue }
    const change = computeDayChange({
      closePrice: g.closePrice,
      candleTimestamp: g.candleTimestamp,
      interval: g.interval,
      dailyCandles: await dailyFor(g.exchange, g.symbol),
    })
    if (!change) { unresolved++; continue }
    writes.push({ ref: doc.ref, data: change })
  }

  console.log(`${groups.size} group(s): ${skipped} already set, ${unresolved} without daily data, ${APPLY ? 'writing' : 'would write'} ${writes.length}.`)
  if (!APPLY) return console.log('Dry run - re-run with --apply to write.')
  for (let i = 0; i < writes.length; i += BATCH) {
    const batch = db.batch()
    writes.slice(i, i + BATCH).forEach(({ ref, data }) => batch.update(ref, data))
    await batch.commit()
  }
  console.log('Done.')
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1) })
