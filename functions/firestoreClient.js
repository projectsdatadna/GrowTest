/**
 * Shared Firestore access for reference data (e.g. the underlying-symbol
 * list). Used both by the deployed Cloud Function (functions/index.js) and
 * by the local dev server (root server.js, which imports this file via a
 * relative path - see FIREBASE_DEPLOY.md for why files are shared this way
 * across the two runtimes).
 */

import admin from 'firebase-admin'

if (admin.apps.length === 0) {
  admin.initializeApp({ projectId: 'devgraders' })
}

const db = admin.firestore()

const UNDERLYING_SYMBOLS_COLLECTION = 'referenceData'
const UNDERLYING_SYMBOLS_DOC = 'underlyingSymbols'

// In-memory cache - this is a small, rarely-changing static reference list,
// so one Firestore read per cold start/process lifetime is enough.
let cachedSymbols = null

export async function getUnderlyingSymbols() {
  if (cachedSymbols) {
    return cachedSymbols
  }

  const snapshot = await db.collection(UNDERLYING_SYMBOLS_COLLECTION).doc(UNDERLYING_SYMBOLS_DOC).get()
  cachedSymbols = snapshot.exists ? snapshot.data().symbols || [] : []
  return cachedSymbols
}

export async function setUnderlyingSymbols(symbols) {
  await db.collection(UNDERLYING_SYMBOLS_COLLECTION).doc(UNDERLYING_SYMBOLS_DOC).set({
    symbols,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  })
  cachedSymbols = symbols
}

const SNAPSHOTS_COLLECTION = 'optionChainSnapshots'

// Persists a full Greek Analysis result so it can be browsed/compared later
// from the Compare tab. Called after every analysis run (manual + auto-refresh).
export async function saveOptionChainSnapshot(analysis) {
  const docRef = await db.collection(SNAPSHOTS_COLLECTION).add({
    ...analysis,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  })
  return docRef.id
}

// Lightweight listing for the Compare tab's snapshot pickers - deliberately
// excludes filtered_strikes/parsed_analysis/raw_text so browsing history
// stays cheap even once there are many saved runs.
export async function listOptionChainSnapshots(underlying_symbol, limit = 50) {
  let query = db.collection(SNAPSHOTS_COLLECTION)
  if (underlying_symbol) {
    query = query.where('underlying_symbol', '==', underlying_symbol)
  }
  query = query.orderBy('createdAt', 'desc').limit(limit)

  const snapshot = await query.get()
  return snapshot.docs.map((doc) => {
    const data = doc.data()
    return {
      id: doc.id,
      underlying_symbol: data.underlying_symbol,
      exchange: data.exchange,
      expiry_date: data.expiry_date,
      underlying_ltp: data.underlying_ltp,
      points_range: data.points_range,
      filtered_strikes_count: data.filtered_strikes_count,
      createdAt: data.createdAt?.toDate?.().toISOString() || null,
    }
  })
}

// Fetches one full snapshot (including filtered_strikes/parsed_analysis) by
// ID - this is what feeds compareOptionChainSnapshots/computeGreeksDelta.
export async function getOptionChainSnapshot(id) {
  const doc = await db.collection(SNAPSHOTS_COLLECTION).doc(id).get()
  if (!doc.exists) {
    return null
  }
  const data = doc.data()
  return { id: doc.id, ...data, createdAt: data.createdAt?.toDate?.().toISOString() || null }
}
