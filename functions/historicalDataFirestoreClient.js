/**
 * Firestore access for the Historical Chart feature - candles fetched
 * on-demand from Groww per symbol/exchange/interval, plus the technical
 * indicator series computed from them. Used by both the deployed Cloud
 * Function (functions/index.js) and the local dev server (root server.js),
 * same relative-import pattern as watchlistFirestoreClient.js.
 *
 * Unlike every other collection in this app, candles and indicator points
 * use a DETERMINISTIC doc ID instead of .add() - they're re-fetchable/
 * idempotent (a user can revisit the same symbol/interval any time), so a
 * deterministic ID lets storing "possibly already-stored" data be a safe
 * batch.set() overwrite with no read-before-write dedup logic, unlike the
 * append-only event logs (watchlistSnapshots, optionChainSnapshots) that
 * use .add() because they're never re-fetched.
 */

import admin from 'firebase-admin'
import { getFirestore } from 'firebase-admin/firestore'

const PROJECT_ID = 'dev-cogniglob'

// Same dedicated Native-mode database as watchlistFirestoreClient.js (see
// its comment) - dev-cogniglob's default database is Datastore mode and
// belongs to an unrelated app on this shared project.
const DATABASE_ID = 'groww-dashboard'

if (admin.apps.length === 0) {
  admin.initializeApp({ projectId: PROJECT_ID })
}

const db = getFirestore(admin.app(), DATABASE_ID)

const CANDLES_COLLECTION = 'historicalCandles'
const INDICATORS_COLLECTION = 'technicalIndicators'

// Firestore's hard cap on operations per batch.
const BATCH_WRITE_LIMIT = 500

function serializeDoc(doc) {
  const data = doc.data()
  return { ...data, createdAt: data.createdAt?.toDate?.().toISOString() || null }
}

// Doc IDs can't contain '/' (some Groww trading symbols do, e.g. futures/
// options contracts) - sanitize to be safe even though the symbols this
// feature targets today (plain equities/indices) don't need it.
function sanitizeIdPart(value) {
  return String(value).replace(/[^a-zA-Z0-9_.-]/g, '_')
}

export function buildCandleDocId(symbol, exchange, interval, timestamp) {
  return [symbol, exchange, interval, timestamp].map(sanitizeIdPart).join('__')
}

export function buildIndicatorDocId(symbol, exchange, interval, indicator, paramsKey, timestamp) {
  return [symbol, exchange, interval, indicator, paramsKey, timestamp].map(sanitizeIdPart).join('__')
}

// Commits `records` to `collectionName` in chunks of BATCH_WRITE_LIMIT,
// sequentially (not via mapWithConcurrency - a single on-demand fetch is at
// most a handful of chunks, so concurrent commits would buy nothing here).
async function commitInChunks(collectionName, records, buildDocId, buildDocData) {
  for (let i = 0; i < records.length; i += BATCH_WRITE_LIMIT) {
    const chunk = records.slice(i, i + BATCH_WRITE_LIMIT)
    const batch = db.batch()
    chunk.forEach((record) => {
      const ref = db.collection(collectionName).doc(buildDocId(record))
      batch.set(ref, buildDocData(record))
    })
    await batch.commit()
  }
}

export async function getLatestCandleTimestamp(symbol, exchange, interval) {
  const snapshot = await db
    .collection(CANDLES_COLLECTION)
    .where('symbol', '==', symbol)
    .where('exchange', '==', exchange)
    .where('interval', '==', interval)
    .orderBy('timestamp', 'desc')
    .limit(1)
    .get()
  return snapshot.empty ? null : snapshot.docs[0].data().timestamp
}

export async function listCandlesInRange(symbol, exchange, interval, fromTimestamp, toTimestamp) {
  const snapshot = await db
    .collection(CANDLES_COLLECTION)
    .where('symbol', '==', symbol)
    .where('exchange', '==', exchange)
    .where('interval', '==', interval)
    .where('timestamp', '>=', fromTimestamp)
    .where('timestamp', '<=', toTimestamp)
    .orderBy('timestamp', 'asc')
    .get()
  return snapshot.docs.map(serializeDoc)
}

// One row per candle. Called with candles already fetched fresh from Groww
// for this symbol/exchange/interval - batch.set() with a deterministic ID
// makes re-storing an already-present candle a safe no-op overwrite.
export async function saveCandlesBatch(symbol, exchange, interval, candles) {
  await commitInChunks(
    CANDLES_COLLECTION,
    candles,
    (candle) => buildCandleDocId(symbol, exchange, interval, candle.timestamp),
    (candle) => ({
      symbol,
      exchange,
      interval,
      timestamp: candle.timestamp,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    })
  )
}

export async function getLatestIndicatorTimestamp(symbol, exchange, interval, indicator, paramsKey) {
  const snapshot = await db
    .collection(INDICATORS_COLLECTION)
    .where('symbol', '==', symbol)
    .where('exchange', '==', exchange)
    .where('interval', '==', interval)
    .where('indicator', '==', indicator)
    .where('params_key', '==', paramsKey)
    .orderBy('timestamp', 'desc')
    .limit(1)
    .get()
  return snapshot.empty ? null : snapshot.docs[0].data().timestamp
}

export async function listIndicatorSeries(symbol, exchange, interval, indicator, paramsKey) {
  const snapshot = await db
    .collection(INDICATORS_COLLECTION)
    .where('symbol', '==', symbol)
    .where('exchange', '==', exchange)
    .where('interval', '==', interval)
    .where('indicator', '==', indicator)
    .where('params_key', '==', paramsKey)
    .orderBy('timestamp', 'asc')
    .get()
  return snapshot.docs.map((doc) => {
    const data = doc.data()
    return { timestamp: data.timestamp, value: data.value }
  })
}

// One row per indicator value point. `points` are {timestamp, value} pairs
// already computed by technicalIndicators.js - this overwrites the full
// series for this (symbol, exchange, interval, indicator, paramsKey), which
// is safe/idempotent via the deterministic doc ID (see file header).
export async function saveIndicatorSeriesBatch(symbol, exchange, interval, indicator, paramsKey, points) {
  await commitInChunks(
    INDICATORS_COLLECTION,
    points,
    (point) => buildIndicatorDocId(symbol, exchange, interval, indicator, paramsKey, point.timestamp),
    (point) => ({
      symbol,
      exchange,
      interval,
      indicator,
      params_key: paramsKey,
      timestamp: point.timestamp,
      value: point.value,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    })
  )
}
