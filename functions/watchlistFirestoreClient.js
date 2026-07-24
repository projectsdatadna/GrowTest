/**
 * Firestore access for the Watchlist feature - a separate set of collections
 * from optionChainSnapshots (Greek Analysis/Compare tab's manual history),
 * since watchlistSnapshots/watchlistAnalyses get wiped every day after
 * market close while optionChainSnapshots never does. Used by both the
 * deployed Cloud Function (functions/index.js) and the local dev server
 * (root server.js), same relative-import pattern as firestoreClient.js.
 */

import admin from 'firebase-admin'

if (admin.apps.length === 0) {
  admin.initializeApp({ projectId: 'devgraders' })
}

const db = admin.firestore()

const WATCHLIST_COLLECTION = 'watchlist'
const WATCHLIST_SNAPSHOTS_COLLECTION = 'watchlistSnapshots'
const WATCHLIST_ANALYSES_COLLECTION = 'watchlistAnalyses'

function serializeDoc(doc) {
  const data = doc.data()
  return { id: doc.id, ...data, createdAt: data.createdAt?.toDate?.().toISOString() || null }
}

// The tracked-symbol config list - persists across days, never touched by
// the daily cleanup job.
export async function createWatchlistEntry({ underlying_symbol, exchange, expiry_date, points_range }) {
  const docRef = await db.collection(WATCHLIST_COLLECTION).add({
    underlying_symbol,
    exchange,
    expiry_date,
    points_range,
    active: true,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  })
  return docRef.id
}

export async function listActiveWatchlistEntries() {
  const snapshot = await db.collection(WATCHLIST_COLLECTION).where('active', '==', true).orderBy('createdAt', 'asc').get()
  return snapshot.docs.map(serializeDoc)
}

// Soft delete - keeps the doc (and its id, for any historical reference)
// but excludes it from listActiveWatchlistEntries and future ticks.
export async function deactivateWatchlistEntry(id) {
  await db.collection(WATCHLIST_COLLECTION).doc(id).update({ active: false })
}

// One row per 5-minute rolling fetch - the raw data source all three tiers
// read from by time-lookup via findWatchlistSnapshotNear.
export async function saveWatchlistSnapshot({ watchlist_id, underlying_ltp, filtered_strikes }) {
  const docRef = await db.collection(WATCHLIST_SNAPSHOTS_COLLECTION).add({
    watchlist_id,
    underlying_ltp,
    filtered_strikes,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  })
  return docRef.id
}

// Finds the watchlistSnapshots row closest to `targetDate` for this
// watchlist entry, within +/- toleranceMinutes (half the 5-minute tick
// interval by default, to unambiguously match "N minutes ago" without
// picking up an adjacent tick). Returns null if nothing falls in range -
// the caller then proceeds without a `previous` snapshot, exactly like a
// first-ever run degrades gracefully today.
export async function findWatchlistSnapshotNear(watchlist_id, targetDate, toleranceMinutes = 2.5) {
  const toleranceMs = toleranceMinutes * 60 * 1000
  const rangeStart = new Date(targetDate.getTime() - toleranceMs)
  const rangeEnd = new Date(targetDate.getTime() + toleranceMs)

  const snapshot = await db
    .collection(WATCHLIST_SNAPSHOTS_COLLECTION)
    .where('watchlist_id', '==', watchlist_id)
    .where('createdAt', '>=', rangeStart)
    .where('createdAt', '<=', rangeEnd)
    .get()

  if (snapshot.empty) return null

  const candidates = snapshot.docs.map(serializeDoc)
  candidates.sort((a, b) => Math.abs(new Date(a.createdAt) - targetDate) - Math.abs(new Date(b.createdAt) - targetDate))
  return candidates[0]
}

// One row per tier-tick per watchlist entry - both AI analyses side by side,
// each already diff-aware when a previous snapshot was found for this tier.
// Also carries the raw current/previous snapshots (for the client's
// Current/Previous/Difference columns) and the prior tick's own AI reports
// (for a real, non-fabricated Previous-column report) - see
// getWatchlistAnalysisBySnapshotId below.
export async function saveWatchlistAnalysis({
  watchlist_id,
  tier,
  current_snapshot_id,
  previous_snapshot_id,
  underlying_ltp,
  master_prompt_analysis,
  summarized_recommendations_analysis,
  current_snapshot,
  previous_snapshot,
  previous_master_prompt_analysis,
  previous_summarized_recommendations_analysis,
}) {
  const docRef = await db.collection(WATCHLIST_ANALYSES_COLLECTION).add({
    watchlist_id,
    tier,
    current_snapshot_id,
    previous_snapshot_id: previous_snapshot_id || null,
    underlying_ltp,
    master_prompt_analysis,
    summarized_recommendations_analysis,
    current_snapshot: current_snapshot || null,
    previous_snapshot: previous_snapshot || null,
    previous_master_prompt_analysis: previous_master_prompt_analysis || null,
    previous_summarized_recommendations_analysis: previous_summarized_recommendations_analysis || null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  })
  return docRef.id
}

export async function getLatestWatchlistAnalysis(watchlist_id, tier) {
  const snapshot = await db
    .collection(WATCHLIST_ANALYSES_COLLECTION)
    .where('watchlist_id', '==', watchlist_id)
    .where('tier', '==', tier)
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get()
  return snapshot.empty ? null : serializeDoc(snapshot.docs[0])
}

// Finds the watchlistAnalyses doc that was current as of a given past
// snapshot, for the same tier - i.e. "what did our own AI report look like
// last tick" - so the Previous column can show a real, already-computed
// report instead of none at all. Returns null for the first few ticks of the
// day (or if that tier's analysis somehow failed at that tick).
export async function getWatchlistAnalysisBySnapshotId(watchlist_id, tier, snapshot_id) {
  if (!snapshot_id) return null
  const snapshot = await db
    .collection(WATCHLIST_ANALYSES_COLLECTION)
    .where('watchlist_id', '==', watchlist_id)
    .where('tier', '==', tier)
    .where('current_snapshot_id', '==', snapshot_id)
    .limit(1)
    .get()
  return snapshot.empty ? null : serializeDoc(snapshot.docs[0])
}

// Firestore has no single "delete collection" operation - queries and
// deletes in batches until the collection is empty. Used by the daily
// cleanup job on watchlistSnapshots/watchlistAnalyses only - watchlist
// (the tracked-symbol config list) is never passed to this.
export async function deleteAllDocsInCollection(collectionName, batchSize = 300) {
  let deletedTotal = 0
  let hasMore = true
  while (hasMore) {
    const snapshot = await db.collection(collectionName).limit(batchSize).get()
    if (snapshot.empty) {
      hasMore = false
      break
    }

    const batch = db.batch()
    snapshot.docs.forEach((doc) => batch.delete(doc.ref))
    await batch.commit()
    deletedTotal += snapshot.size

    hasMore = snapshot.size === batchSize
  }
  return deletedTotal
}
