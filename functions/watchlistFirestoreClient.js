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

export async function getWatchlistEntry(id) {
  const doc = await db.collection(WATCHLIST_COLLECTION).doc(id).get()
  return doc.exists ? serializeDoc(doc) : null
}

// Records the real Groww API error (or "no token saved" error) from the last
// failed fetch attempt for this entry, so GET /watchlist/:id/analysis/:tier
// can surface it to the client instead of just silently returning stale/null
// analysis. `error_details` is a plain JSON-serializable object - callers
// embed their own `occurred_at` ISO string in it, since Firestore Timestamps
// don't round-trip cleanly through a single nested field like this.
export async function saveWatchlistFetchError(id, error_details) {
  await db.collection(WATCHLIST_COLLECTION).doc(id).update({ last_fetch_error: error_details })
}

// Clears a previously-recorded fetch error once a fetch succeeds again, so
// the analysis response goes back to not including one.
export async function clearWatchlistFetchError(id) {
  await db.collection(WATCHLIST_COLLECTION).doc(id).update({ last_fetch_error: null })
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
// watchlist entry - no FIXED tolerance window: real tick spacing drifts
// (observed anywhere from ~6 to ~8+ minutes apart in production, worsening as
// more symbols/AI calls load up each tick), so rejecting anything further
// than a fixed distance from `targetDate` meant the "previous" snapshot was
// almost never found once the schedule drifted off a clean N-minute grid -
// the closest available snapshot IS the best approximation of "N minutes
// ago" regardless of how far the real cadence has drifted. `excludeSnapshotId`
// filters out the snapshot this same tick just saved, so the very first tick
// of the day - with no real previous snapshot yet - can't match itself.
// Returns null if there's nothing else for this entry yet, same as a
// first-ever run degrades gracefully today.
//
// `maxDistanceMs`, if given, rejects a match that's further from `targetDate`
// than that (returning null instead) - added after 5m/15m/75m were observed
// all resolving to the literal same snapshot doc when an entry's history was
// thin (right after the daily wipe, or a newly-added symbol): with no
// ceiling at all, "closest available" degrades to "whatever exists" rather
// than a genuine approximation of "N minutes ago". Callers pass a
// tier-relative bound (e.g. a multiple of that tier's own window) rather than
// a fixed number of minutes, so this doesn't reintroduce the fixed-tolerance
// bug above - it still tolerates real-world drift, just not an unbounded one.
export async function findWatchlistSnapshotNear(watchlist_id, targetDate, excludeSnapshotId = null, maxDistanceMs = null) {
  const snapshot = await db.collection(WATCHLIST_SNAPSHOTS_COLLECTION).where('watchlist_id', '==', watchlist_id).get()
  if (snapshot.empty) return null

  const candidates = snapshot.docs.map(serializeDoc).filter((doc) => doc.id !== excludeSnapshotId)
  if (candidates.length === 0) return null

  candidates.sort((a, b) => Math.abs(new Date(a.createdAt) - targetDate) - Math.abs(new Date(b.createdAt) - targetDate))
  const closest = candidates[0]
  if (maxDistanceMs != null && Math.abs(new Date(closest.createdAt) - targetDate) > maxDistanceMs) {
    return null
  }
  return closest
}

// One row per tier-tick per watchlist entry - both AI analyses side by side,
// each already diff-aware when a previous snapshot was found for this tier.
// Also carries the raw current/previous snapshots (for the client's
// Current/Previous/Difference columns) and the prior tick's own AI reports
// (for a real, non-fabricated Previous-column report - see analyzeTier in
// watchlistScheduler.js, which reads getLatestWatchlistAnalysis for this tier
// before writing the new doc below).
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
