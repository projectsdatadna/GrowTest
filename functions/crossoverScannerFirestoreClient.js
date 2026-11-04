/**
 * Firestore access for the Crossover Scanner - the list of symbols scanned
 * once per closed 1-hour candle (see crossoverScanner.js), plus the crossover
 * alerts it raises.
 *
 * Alerts are written into the SAME `historicalWatchlistNotifications`
 * collection the AppShell bell already polls (type: 'crossover'), so the bell
 * and the existing read / mark-all-read routes work with no changes beyond a
 * new render branch.
 */

import admin from 'firebase-admin'
import { getFirestore } from 'firebase-admin/firestore'

const PROJECT_ID = 'dev-cogniglob'
const DATABASE_ID = 'groww-dashboard'

if (admin.apps.length === 0) {
  admin.initializeApp({ projectId: PROJECT_ID })
}

const db = getFirestore(admin.app(), DATABASE_ID)

const SYMBOLS_COLLECTION = 'crossoverScannerSymbols'
const NOTIFICATIONS_COLLECTION = 'historicalWatchlistNotifications'

// Seeded on first use (ensureSeeded) - the user can add/remove from here.
export const DEFAULT_SCANNER_SYMBOLS = [
  'GODREJPROP',
  'BPCL',
  'NYKAA',
  'NESTLEIND',
  '360ONE',
  'ULTRACEMCO',
  'JIOFIN',
  'RVNL',
  'IRFC',
  'CUMMINSIND',
  'TATASTEEL',
  'PFC',
  'VMM',
]

const ALREADY_EXISTS_CODE = 6

function serializeSymbolDoc(doc) {
  const data = doc.data()
  return {
    id: doc.id,
    ...data,
    createdAt: data.createdAt?.toDate?.().toISOString() || null,
    lastScanAt: data.lastScanAt?.toDate?.().toISOString() || null,
  }
}

function serializeNotificationDoc(doc) {
  const data = doc.data()
  return { id: doc.id, ...data, createdAt: data.createdAt?.toDate?.().toISOString() || null }
}

// Deterministic id (exchange + symbol) makes add idempotent and lets DELETE
// address a symbol without a lookup.
export function scannerSymbolId(exchange, symbol) {
  return `${exchange}_${symbol}`
}

// No orderBy on the query (so no composite index needed) - the list is tiny,
// sort in memory by createdAt.
export async function listActiveScannerSymbols() {
  const snapshot = await db.collection(SYMBOLS_COLLECTION).where('active', '==', true).get()
  return snapshot.docs.map(serializeSymbolDoc).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.symbol.localeCompare(b.symbol))
}

// Idempotent: re-adding an existing symbol just reactivates it (clearing any
// soft-delete) instead of creating a duplicate.
export async function addScannerSymbol({ symbol, exchange = 'NSE', source = 'manual' }) {
  const id = scannerSymbolId(exchange, symbol)
  const ref = db.collection(SYMBOLS_COLLECTION).doc(id)
  const existing = await ref.get()
  if (existing.exists) {
    await ref.update({ active: true })
    return { id, created: !existing.data().active }
  }
  await ref.set({
    symbol,
    exchange,
    source,
    active: true,
    lastScanAt: null,
    lastScannedCandleTs: null,
    lastError: null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  })
  return { id, created: true }
}

// Soft delete, same as the Historical Watchlist - keeps the doc but excludes
// it from future scans.
export async function deactivateScannerSymbol(id) {
  await db.collection(SYMBOLS_COLLECTION).doc(id).update({ active: false })
}

// Seeds the default list only when the collection has never been used, so a
// symbol the user deliberately removed is never silently re-added.
export async function ensureSeeded() {
  const probe = await db.collection(SYMBOLS_COLLECTION).limit(1).get()
  if (!probe.empty) return false
  for (const symbol of DEFAULT_SCANNER_SYMBOLS) {
    await addScannerSymbol({ symbol, exchange: 'NSE', source: 'seed' })
  }
  return true
}

export async function updateScanState(id, { lastScannedCandleTs }) {
  await db.collection(SYMBOLS_COLLECTION).doc(id).update({
    lastScanAt: admin.firestore.FieldValue.serverTimestamp(),
    lastScannedCandleTs,
    lastError: null,
  })
}

export async function saveScanError(id, message) {
  await db.collection(SYMBOLS_COLLECTION).doc(id).update({
    lastError: { message, at: new Date().toISOString() },
  })
}

// Creates one alert under a caller-supplied deterministic id. create() fails
// with ALREADY_EXISTS if that id is taken, which is the dedup: a re-run, a
// retry, or overlapping 2-candle lookback windows can never raise the same
// crossover twice. Returns true only when a NEW alert was written.
export async function createCrossoverNotification(id, fields) {
  try {
    await db.collection(NOTIFICATIONS_COLLECTION).doc(id).create({
      ...fields,
      type: 'crossover',
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    })
    return true
  } catch (error) {
    if (error.code === ALREADY_EXISTS_CODE) return false
    throw error
  }
}

// Same idempotent-create shape for the once-a-day "token missing" warning -
// the id embeds the IST date, so repeated failed runs the same day raise one.
export async function createScannerWarningNotification(id, { message }) {
  try {
    await db.collection(NOTIFICATIONS_COLLECTION).doc(id).create({
      type: 'scanner_warning',
      message,
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    })
    return true
  } catch (error) {
    if (error.code === ALREADY_EXISTS_CODE) return false
    throw error
  }
}

// Needs the (type, createdAt DESC) composite index in firestore.indexes.json.
export async function listCrossoverNotifications({ limit = 50 } = {}) {
  const snapshot = await db
    .collection(NOTIFICATIONS_COLLECTION)
    .where('type', '==', 'crossover')
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get()
  return snapshot.docs.map(serializeNotificationDoc)
}
