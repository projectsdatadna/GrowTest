/**
 * One-off: builds crossover groups (the Notifications page's merged cards)
 * from crossover notifications that predate them - one group per
 * (exchange, symbol, interval, candleTimestamp). A group is read only when all
 * its notifications are read. ADX is not known for old bars (shows "-").
 * Existing groups are left untouched, so it is safe to re-run.
 *
 *   node functions/scripts/backfillCrossoverGroups.mjs           # dry run
 *   node functions/scripts/backfillCrossoverGroups.mjs --apply
 *
 * Run after migrateAdxToDmi.mjs and importSymbolOrder.mjs, so labels and
 * order are current.
 */

import admin from 'firebase-admin'
import { scannerDb as db, SCANNER_COLLECTIONS, crossoverGroupId, isIndexSymbol, UNLISTED_SORT_ORDER } from '../crossoverScannerFirestoreClient.js'
import { buildCrossoverGroups } from '../crossoverScanner.js'

const APPLY = process.argv.includes('--apply')
const BATCH = 400

async function main() {
  const [notifications, symbols, existing] = await Promise.all([
    db.collection(SCANNER_COLLECTIONS.notifications).where('type', '==', 'crossover').get(),
    db.collection(SCANNER_COLLECTIONS.symbols).get(),
    db.collection(SCANNER_COLLECTIONS.groups).select().get(),
  ])
  const symbolInfo = new Map(symbols.docs.map((d) => [d.id, d.data()]))
  const existingIds = new Set(existing.docs.map((d) => d.id))

  const buckets = new Map()
  for (const doc of notifications.docs) {
    const n = doc.data()
    if (n.candleTimestamp == null || !n.interval) continue
    const key = crossoverGroupId(n)
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push({ ...n, id: doc.id, spec: n.indicator })
  }

  const writes = []
  for (const [id, items] of buckets) {
    if (existingIds.has(id)) continue
    const info = symbolInfo.get(`${items[0].exchange}_${items[0].symbol}`) || {}
    const [group] = buildCrossoverGroups(items, {
      isIndex: info.isIndex ?? isIndexSymbol(items[0].symbol),
      sortOrder: info.sortOrder ?? UNLISTED_SORT_ORDER,
    })
    const createdAt = items.map((i) => i.createdAt).filter(Boolean).sort((a, b) => a.toMillis() - b.toMillis())[0] || admin.firestore.Timestamp.now()
    writes.push({ id, data: { ...group, read: items.every((i) => i.read), createdAt } })
  }

  const stars = writes.reduce((m, w) => ((m[w.data.stars] = (m[w.data.stars] || 0) + 1), m), {})
  console.log(`${notifications.size} crossover notification(s) -> ${buckets.size} group(s); ${existingIds.size} already exist; ${APPLY ? 'writing' : 'would write'} ${writes.length}. Stars distribution: ${JSON.stringify(stars)}`)
  if (!APPLY) return console.log('Dry run - re-run with --apply to write.')
  for (let i = 0; i < writes.length; i += BATCH) {
    const batch = db.batch()
    writes.slice(i, i + BATCH).forEach(({ id, data }) => batch.set(db.collection(SCANNER_COLLECTIONS.groups).doc(id), data))
    await batch.commit()
  }
  console.log('Done.')
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error)
  process.exit(1)
})
