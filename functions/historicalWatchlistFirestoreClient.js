/**
 * Firestore access for the Historical Watchlist feature - a separate set of
 * collections from the option-chain `watchlist`/`watchlistSnapshots`/
 * `watchlistAnalyses` ones (watchlistFirestoreClient.js), since this tracks
 * candle/indicator refresh state per symbol+interval rather than option-chain
 * snapshots. Used by both the deployed Cloud Functions (functions/index.js)
 * and the local dev server (root server.js), same relative-import pattern as
 * watchlistFirestoreClient.js.
 */

import admin from 'firebase-admin'
import { getFirestore } from 'firebase-admin/firestore'

const PROJECT_ID = 'dev-cogniglob'

// Same dedicated Native-mode database as the rest of this app's Firestore
// clients - dev-cogniglob's default database belongs to an unrelated app.
const DATABASE_ID = 'groww-dashboard'

if (admin.apps.length === 0) {
  admin.initializeApp({ projectId: PROJECT_ID })
}

const db = getFirestore(admin.app(), DATABASE_ID)

const HISTORICAL_WATCHLIST_COLLECTION = 'historicalWatchlist'
const HISTORICAL_WATCHLIST_NOTIFICATIONS_COLLECTION = 'historicalWatchlistNotifications'

function serializeDoc(doc) {
  const data = doc.data()
  return {
    id: doc.id,
    ...data,
    createdAt: data.createdAt?.toDate?.().toISOString() || null,
    lastFetchedAt: data.lastFetchedAt?.toDate?.().toISOString() || null,
  }
}

// The tracked (symbol, exchange, interval) config list - persists
// indefinitely, refreshed on its own configured interval by
// historicalWatchlistDispatch/historicalWatchlistFetchTask (functions/index.js).
export async function createHistoricalWatchlistEntry({ symbol, exchange, interval, indicatorSpecs }) {
  const docRef = await db.collection(HISTORICAL_WATCHLIST_COLLECTION).add({
    symbol,
    exchange,
    interval,
    indicatorSpecs: indicatorSpecs || [],
    active: true,
    lastFetchedAt: null,
    lastFetchedCandleTimestamp: null,
    lastError: null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  })
  return docRef.id
}

export async function listActiveHistoricalWatchlistEntries() {
  const snapshot = await db.collection(HISTORICAL_WATCHLIST_COLLECTION).where('active', '==', true).orderBy('createdAt', 'asc').get()
  return snapshot.docs.map(serializeDoc)
}

export async function getHistoricalWatchlistEntry(id) {
  const doc = await db.collection(HISTORICAL_WATCHLIST_COLLECTION).doc(id).get()
  return doc.exists ? serializeDoc(doc) : null
}

// Soft delete - keeps the doc (and its id, for any historical reference) but
// excludes it from listActiveHistoricalWatchlistEntries and future ticks.
export async function deactivateHistoricalWatchlistEntry(id) {
  await db.collection(HISTORICAL_WATCHLIST_COLLECTION).doc(id).update({ active: false })
}

// Advances the entry's fetch-state after a successful processDueEntry run
// (functions/historicalWatchlistScheduler.js) - lastFetchedCandleTimestamp is
// what makes notification creation idempotent across Cloud Tasks retries (a
// notification is only created if the new latest candle timestamp is newer
// than the value already stored here).
export async function updateHistoricalWatchlistFetchState(id, { lastFetchedCandleTimestamp }) {
  await db.collection(HISTORICAL_WATCHLIST_COLLECTION).doc(id).update({
    lastFetchedAt: admin.firestore.FieldValue.serverTimestamp(),
    lastFetchedCandleTimestamp,
    lastError: null,
  })
}

// Records the real error from the last failed fetch attempt for this entry -
// Cloud Tasks' own retryConfig handles retrying the task itself, this is
// just for surfacing "what went wrong" in the watchlist panel UI.
export async function saveHistoricalWatchlistFetchError(id, message) {
  await db.collection(HISTORICAL_WATCHLIST_COLLECTION).doc(id).update({
    lastError: { message, at: new Date().toISOString() },
  })
}

// One row per detected data update - read by the AppShell bell icon
// (poll-based, matching WatchlistTab's own polling convention).
export async function createHistoricalWatchlistNotification({ watchlistId, symbol, exchange, interval, newCandleCount, latestCandleTimestamp }) {
  const docRef = await db.collection(HISTORICAL_WATCHLIST_NOTIFICATIONS_COLLECTION).add({
    watchlistId,
    symbol,
    exchange,
    interval,
    newCandleCount,
    latestCandleTimestamp,
    read: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  })
  return docRef.id
}

export async function listHistoricalWatchlistNotifications({ unreadOnly = false, limit = 20 } = {}) {
  let query = db.collection(HISTORICAL_WATCHLIST_NOTIFICATIONS_COLLECTION).orderBy('createdAt', 'desc').limit(limit)
  if (unreadOnly) query = db.collection(HISTORICAL_WATCHLIST_NOTIFICATIONS_COLLECTION).where('read', '==', false).orderBy('createdAt', 'desc').limit(limit)
  const snapshot = await query.get()
  return snapshot.docs.map(serializeDoc)
}

export async function markHistoricalWatchlistNotificationRead(id) {
  await db.collection(HISTORICAL_WATCHLIST_NOTIFICATIONS_COLLECTION).doc(id).update({ read: true })
}

// Marks every currently-unread notification read in one batch (Firestore has
// no bulk-update-by-query, so this reads the unread set then batches the
// writes - same shape as deleteAllDocsInCollection's batching elsewhere).
export async function markAllHistoricalWatchlistNotificationsRead() {
  const snapshot = await db.collection(HISTORICAL_WATCHLIST_NOTIFICATIONS_COLLECTION).where('read', '==', false).get()
  if (snapshot.empty) return 0
  const batch = db.batch()
  snapshot.docs.forEach((doc) => batch.update(doc.ref, { read: true }))
  await batch.commit()
  return snapshot.size
}
