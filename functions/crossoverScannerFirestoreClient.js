/**
 * Firestore access for the Crossover Scanner - the single symbol list scanned
 * on every timeframe (see crossoverScanner.js), per-timeframe scan state,
 * scanner settings / run status, and the unified notifications feed.
 *
 * Alerts are written into the SAME `historicalWatchlistNotifications`
 * collection the bell and Notifications page read (type: 'crossover'), next
 * to the Historical Watchlist's candle/AI items. Everything with an
 * `interval` field is grouped by timeframe for display.
 */

import admin from 'firebase-admin'
import { getFirestore } from 'firebase-admin/firestore'
import { DEFAULT_ENABLED_INTERVALS, DEFAULT_POPUP_INTERVALS } from './crossoverTimeframes.js'

const PROJECT_ID = 'dev-cogniglob'
const DATABASE_ID = 'groww-dashboard'

if (admin.apps.length === 0) {
  admin.initializeApp({ projectId: PROJECT_ID })
}

const db = getFirestore(admin.app(), DATABASE_ID)

const SYMBOLS_COLLECTION = 'crossoverScannerSymbols'
const NOTIFICATIONS_COLLECTION = 'historicalWatchlistNotifications'
const APP_CONFIG_COLLECTION = 'appConfig'
const SETTINGS_DOC = 'crossoverScanner'
const STATUS_DOC = 'crossoverScannerStatus'

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
const BATCH_LIMIT = 400

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

// ---------- symbol list (one list for every timeframe) ----------

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
    scanState: {},
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

// ---------- per-timeframe scan state ----------

// scanState is {[interval]: {lastBarEnd, lastScanAt, lastError, backfilledAt,
// pendingEnd, attempts, skippedEnd}}. A merge-set with a nested object deep-
// merges the map, so patching one interval never clobbers another's state
// (and avoids dotted field paths, which Firestore rejects for segments like
// "1hour" that start with a digit).
export async function setIntervalState(id, interval, patch) {
  await db
    .collection(SYMBOLS_COLLECTION)
    .doc(id)
    .set({ scanState: { [interval]: patch } }, { merge: true })
}

// ---------- settings and run status (appConfig) ----------

export async function getScannerSettings() {
  const doc = await db.collection(APP_CONFIG_COLLECTION).doc(SETTINGS_DOC).get()
  const data = doc.exists ? doc.data() : {}
  return {
    enabledIntervals: Array.isArray(data.enabledIntervals) ? data.enabledIntervals : DEFAULT_ENABLED_INTERVALS,
    popupIntervals: Array.isArray(data.popupIntervals) ? data.popupIntervals : DEFAULT_POPUP_INTERVALS,
  }
}

export async function saveScannerSettings({ enabledIntervals, popupIntervals }) {
  const patch = {}
  if (enabledIntervals) patch.enabledIntervals = enabledIntervals
  if (popupIntervals) patch.popupIntervals = popupIntervals
  await db.collection(APP_CONFIG_COLLECTION).doc(SETTINGS_DOC).set(patch, { merge: true })
  return getScannerSettings()
}

// {lastTickAt, intervals: {[interval]: {...}}, token: {ok, message, at}}
export async function getRunStatus() {
  const doc = await db.collection(APP_CONFIG_COLLECTION).doc(STATUS_DOC).get()
  return doc.exists ? doc.data() : { lastTickAt: null, intervals: {}, token: null }
}

export async function saveRunStatus(patch) {
  await db.collection(APP_CONFIG_COLLECTION).doc(STATUS_DOC).set(patch, { merge: true })
}

// ---------- notifications ----------

// Creates one alert under a caller-supplied deterministic id. create() fails
// with ALREADY_EXISTS if that id is taken, which is the dedup: a re-run, a
// retry, or an overlapping catch-up window can never raise the same
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

// Every notification type, newest first. A single orderBy on createdAt needs
// no composite index; filtering/grouping by type and timeframe happens in the
// client.
export async function listAllNotifications({ limit = 300 } = {}) {
  const snapshot = await db.collection(NOTIFICATIONS_COLLECTION).orderBy('createdAt', 'desc').limit(limit).get()
  return snapshot.docs.map(serializeNotificationDoc)
}

// Server-side count, so the bell badge is exact rather than "unread among the
// latest 20".
export async function countUnreadNotifications() {
  const snapshot = await db.collection(NOTIFICATIONS_COLLECTION).where('read', '==', false).count().get()
  return snapshot.data().count
}

// Marks many notifications read in batched writes (Firestore batches cap at
// 500 operations).
export async function markNotificationsRead(ids) {
  let updated = 0
  for (let i = 0; i < ids.length; i += BATCH_LIMIT) {
    const batch = db.batch()
    for (const id of ids.slice(i, i + BATCH_LIMIT)) {
      batch.update(db.collection(NOTIFICATIONS_COLLECTION).doc(id), { read: true })
    }
    await batch.commit()
    updated += Math.min(BATCH_LIMIT, ids.length - i)
  }
  return updated
}
