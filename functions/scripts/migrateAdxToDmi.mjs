/**
 * One-off: renames the +DI/-DI crossover from "ADX 14 (+DI/-DI)" / ADXCROSS:14
 * to "DMI 14 (+DI/-DI)" / DMICROSS:14 on stored data:
 *   - crossover notifications: indicator, indicatorLabel, confluence[]
 *   - scanner symbols: scanState.<interval>.summary.signals[].label
 *   - crossover groups: indicators[].label/spec, indicatorLabels[]
 * Document ids keep the old spec (they are only used for idempotency).
 *
 *   node functions/scripts/migrateAdxToDmi.mjs           # dry run (counts only)
 *   node functions/scripts/migrateAdxToDmi.mjs --apply
 */

import { scannerDb as db, SCANNER_COLLECTIONS } from '../crossoverScannerFirestoreClient.js'

const OLD_LABEL = 'ADX 14 (+DI/-DI)'
const NEW_LABEL = 'DMI 14 (+DI/-DI)'
const OLD_SPEC = 'ADXCROSS:14'
const NEW_SPEC = 'DMICROSS:14'
const APPLY = process.argv.includes('--apply')
const BATCH = 400

const relabel = (label) => (label === OLD_LABEL ? NEW_LABEL : label)

async function commit(updates) {
  if (!APPLY) return
  for (let i = 0; i < updates.length; i += BATCH) {
    const batch = db.batch()
    updates.slice(i, i + BATCH).forEach(({ ref, patch }) => batch.update(ref, patch))
    await batch.commit()
  }
}

async function main() {
  // Notifications: the renamed indicator's own alerts, plus any other alert whose confluence lists it.
  const notifications = await db.collection(SCANNER_COLLECTIONS.notifications).where('type', '==', 'crossover').get()
  const notificationUpdates = []
  for (const doc of notifications.docs) {
    const d = doc.data()
    const patch = {}
    if (d.indicatorLabel === OLD_LABEL) Object.assign(patch, { indicatorLabel: NEW_LABEL, indicator: NEW_SPEC })
    if (Array.isArray(d.confluence) && d.confluence.includes(OLD_LABEL)) patch.confluence = d.confluence.map(relabel)
    if (Object.keys(patch).length) notificationUpdates.push({ ref: doc.ref, patch })
  }
  const own = notificationUpdates.filter((u) => u.patch.indicatorLabel).length

  const symbols = await db.collection(SCANNER_COLLECTIONS.symbols).get()
  const symbolUpdates = []
  for (const doc of symbols.docs) {
    const scanState = doc.data().scanState || {}
    let changed = false
    const next = {}
    for (const [interval, state] of Object.entries(scanState)) {
      const signals = state?.summary?.signals
      if (Array.isArray(signals) && signals.some((s) => s.label === OLD_LABEL)) {
        changed = true
        next[interval] = { ...state, summary: { ...state.summary, signals: signals.map((s) => ({ ...s, label: relabel(s.label) })) } }
      } else next[interval] = state
    }
    if (changed) symbolUpdates.push({ ref: doc.ref, patch: { scanState: next } })
  }

  const groups = await db.collection(SCANNER_COLLECTIONS.groups).where('indicatorLabels', 'array-contains', OLD_LABEL).get()
  const groupUpdates = groups.docs.map((doc) => {
    const d = doc.data()
    return {
      ref: doc.ref,
      patch: {
        indicatorLabels: d.indicatorLabels.map(relabel),
        indicators: d.indicators.map((i) => (i.label === OLD_LABEL ? { ...i, label: NEW_LABEL, spec: NEW_SPEC } : i)),
      },
    }
  })

  console.log(`${APPLY ? 'Updating' : 'Would update'}: ${notificationUpdates.length} notification(s) (${own} DMI alerts, ${notificationUpdates.length - own} confluence-only), ${symbolUpdates.length} symbol summary doc(s), ${groupUpdates.length} group(s).`)
  await commit(notificationUpdates)
  await commit(symbolUpdates)
  await commit(groupUpdates)
  if (!APPLY) console.log('Dry run - re-run with --apply to write.')
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error)
  process.exit(1)
})
