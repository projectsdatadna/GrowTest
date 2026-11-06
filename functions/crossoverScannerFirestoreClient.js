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
import { DEFAULT_ENABLED_INTERVALS, DEFAULT_POPUP_INTERVALS, DEFAULT_MIN_AGREEMENT, SETTINGS_VERSION } from './crossoverTimeframes.js'

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

// The Overview page's data: per active symbol, each timeframe's last processed
// bar, error and crossover summary (written on every scan, see
// scanSymbolInterval). Kept out of the symbols list response, which the
// Scanner page polls and which has no use for the summaries.
export async function listOverview() {
  const symbols = await listActiveScannerSymbols()
  return symbols
    .map((entry) => ({
      id: entry.id,
      symbol: entry.symbol,
      exchange: entry.exchange,
      intervals: Object.fromEntries(
        Object.entries(entry.scanState || {}).map(([interval, state]) => [
          interval,
          { lastBarEnd: state.lastBarEnd ?? null, lastScanAt: state.lastScanAt ?? null, lastError: state.lastError ?? null, summary: state.summary ?? null },
        ])
      ),
    }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol))
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
  let data = doc.exists ? doc.data() : {}
  // One-time reset of popup/agreement values saved under older defaults
  // (15 min popups off, 3+ agreement) so the new instant-popup defaults apply.
  if (doc.exists && (data.settingsVersion || 1) < SETTINGS_VERSION) {
    const reset = { popupIntervals: DEFAULT_POPUP_INTERVALS, minAgreement: DEFAULT_MIN_AGREEMENT, settingsVersion: SETTINGS_VERSION }
    await db.collection(APP_CONFIG_COLLECTION).doc(SETTINGS_DOC).set(reset, { merge: true })
    data = { ...data, ...reset }
  }
  return {
    enabledIntervals: Array.isArray(data.enabledIntervals) ? data.enabledIntervals : DEFAULT_ENABLED_INTERVALS,
    popupIntervals: Array.isArray(data.popupIntervals) ? data.popupIntervals : DEFAULT_POPUP_INTERVALS,
    // Per-timeframe minimum number of agreeing indicators for an alert; any
    // timeframe not saved yet falls back to its default.
    minAgreement: { ...DEFAULT_MIN_AGREEMENT, ...(data.minAgreement || {}) },
  }
}

export async function saveScannerSettings({ enabledIntervals, popupIntervals, minAgreement }) {
  const patch = {}
  if (enabledIntervals) patch.enabledIntervals = enabledIntervals
  if (popupIntervals) patch.popupIntervals = popupIntervals
  // merge:true deep-merges this map, so saving one timeframe keeps the rest.
  if (minAgreement) patch.minAgreement = minAgreement
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

// Notifications created after `since` (ISO string), oldest first - the live
// feed behind the popup / Notifications page. Single-field range + orderBy, so
// no composite index. The caller passes a cursor slightly in the past: serverTimestamp
// values from concurrent writers can commit out of order, and ids are de-duplicated
// client-side.
export async function listNotificationsSince({ since, limit = 500 } = {}) {
  const sinceDate = new Date(since)
  const snapshot = await db
    .collection(NOTIFICATIONS_COLLECTION)
    .where('createdAt', '>', admin.firestore.Timestamp.fromDate(sinceDate))
    .orderBy('createdAt', 'asc')
    .limit(limit)
    .get()
  return snapshot.docs.map(serializeNotificationDoc)
}

// ---------- paged notification views (the Notifications page) ----------

// Sections the page is grouped into: the five scanner timeframes plus 'system'
// (scanner warnings, which carry no interval).
const SYSTEM_SECTION = 'system'
const SECTION_KEYS = [...DEFAULT_ENABLED_INTERVALS, SYSTEM_SECTION]

// One section's query with the user's filters applied. Only equality filters
// (Firestore merges the single-field/composite indexes for these, see
// firestore.indexes.json), so there is no substring search: `symbol` is an exact
// match. Returns null when the filters can't match anything in this section.
function sectionQuery(section, { type, unreadOnly, indicator, direction, symbol, from, to } = {}) {
  let query = db.collection(NOTIFICATIONS_COLLECTION)
  if (section === SYSTEM_SECTION) {
    if (type && type !== 'scanner_warning') return null
    // Warnings carry no direction/symbol/indicator, so these filters match nothing.
    if (direction || symbol || indicator?.length) return null
    query = query.where('type', '==', 'scanner_warning')
  } else {
    query = query.where('interval', '==', section)
    if (type) query = query.where('type', '==', type)
  }
  if (unreadOnly) query = query.where('read', '==', false)
  if (indicator?.length === 1) query = query.where('indicatorLabel', '==', indicator[0])
  else if (indicator?.length > 1) query = query.where('indicatorLabel', 'in', indicator)
  if (direction) query = query.where('direction', '==', direction)
  if (symbol) query = query.where('symbol', '==', symbol)
  // Optional date range. Timeframe sections filter on the crossover's own bar time
  // (candleTimestamp, epoch seconds - what the page shows as "Crossed ..."), NOT
  // createdAt: back-filled/late-scanned crossovers are written long after they
  // happened. System warnings have no bar, so they use createdAt.
  if (section === SYSTEM_SECTION) {
    if (from) query = query.where('createdAt', '>=', admin.firestore.Timestamp.fromDate(new Date(from)))
    if (to) query = query.where('createdAt', '<=', admin.firestore.Timestamp.fromDate(new Date(to)))
  } else {
    if (from) query = query.where('candleTimestamp', '>=', Math.floor(Date.parse(from) / 1000))
    if (to) query = query.where('candleTimestamp', '<=', Math.floor(Date.parse(to) / 1000))
  }
  return query
}

// The field a section is ordered (and range-filtered) by: the crossover bar time
// for timeframe sections, createdAt for System.
const orderField = (section) => (section === SYSTEM_SECTION ? 'createdAt' : 'candleTimestamp')

// One numbered page of a section, newest first, plus the section's total for
// these filters. Offset paging: skipped docs are billed as reads, fine at this
// scale (page 20 of 25 = 500 reads).
export async function queryNotificationsPage(section, filters = {}, { page = 1, pageSize = 25 } = {}) {
  const query = sectionQuery(section, filters)
  if (!query) return { items: [], total: 0 }
  const [snapshot, count] = await Promise.all([
    query.orderBy(orderField(section), 'desc').offset((page - 1) * pageSize).limit(pageSize).get(),
    query.count().get(),
  ])
  return { items: snapshot.docs.map(serializeNotificationDoc), total: count.data().count }
}

// {[section]: {total, unread, bullish, bearish, unreadBullish, unreadBearish, lastCrossover}} for every section under the
// same filters, so the page can show section headers and overview cards without
// loading their items. bullish/bearish ignore the direction filter (the cards
// always show both sides) but honour every other filter; the System section has
// no direction so both are 0.
export async function countNotificationsBySection(filters = {}) {
  const entries = await Promise.all(
    SECTION_KEYS.map(async (section) => {
      const all = sectionQuery(section, filters)
      const unread = sectionQuery(section, { ...filters, unreadOnly: true })
      if (!all || !unread) return [section, { total: 0, unread: 0, bullish: 0, bearish: 0, unreadBullish: 0, unreadBearish: 0, lastCrossover: null }]
      const sideCount = async (direction, unreadOnly) => {
        if (section === SYSTEM_SECTION) return 0
        const query = sectionQuery(section, { ...filters, direction, unreadOnly })
        return query ? (await query.count().get()).data().count : 0
      }
      // Epoch seconds of the newest crossover bar in this section (same filters).
      const lastCrossover = async () => {
        if (section === SYSTEM_SECTION) return null
        const query = sectionQuery(section, { ...filters, type: filters.type || 'crossover' })
        if (!query) return null
        const snapshot = await query.orderBy('candleTimestamp', 'desc').limit(1).get()
        return snapshot.empty ? null : snapshot.docs[0].data().candleTimestamp ?? null
      }
      const [total, unreadCount, bullish, bearish, unreadBullish, unreadBearish, last] = await Promise.all([
        all.count().get(),
        unread.count().get(),
        sideCount('bullish', false),
        sideCount('bearish', false),
        sideCount('bullish', true),
        sideCount('bearish', true),
        lastCrossover(),
      ])
      return [section, { total: total.data().count, unread: unreadCount.data().count, bullish, bearish, unreadBullish, unreadBearish, lastCrossover: last }]
    })
  )
  return Object.fromEntries(entries)
}

// ---------- bulk delete (Notifications page "Delete notifications") ----------

// Notifications in the given sections created within [from, to]. Each section is
// its own equality + range query (candleTimestamp, or createdAt for System), so
// the (interval, ..., candleTimestamp) indexes serve it. `maxDocs` bounds one request's work; `hasMore` tells the
// caller to repeat.
function deleteQueries(sections, from, to) {
  return sections.map((section) => sectionQuery(section, { from, to })).filter(Boolean)
}

export async function countNotificationsForDelete({ sections, from, to }) {
  const counts = await Promise.all(deleteQueries(sections, from, to).map(async (q) => (await q.count().get()).data().count))
  return counts.reduce((sum, n) => sum + n, 0)
}

export async function deleteNotificationsInRange({ sections, from, to, maxBatches = 20 }) {
  let deleted = 0
  let batches = 0
  for (const query of deleteQueries(sections, from, to)) {
    while (batches < maxBatches) {
      const snapshot = await query.limit(BATCH_LIMIT).get()
      if (snapshot.empty) break
      const batch = db.batch()
      snapshot.docs.forEach((doc) => batch.delete(doc.ref))
      await batch.commit()
      deleted += snapshot.size
      batches += 1
      if (snapshot.size < BATCH_LIMIT) break
    }
    if (batches >= maxBatches) break
  }
  const remaining = batches >= maxBatches ? await countNotificationsForDelete({ sections, from, to }) : 0
  return { deleted, hasMore: remaining > 0 }
}

export const NOTIFICATION_SECTIONS = SECTION_KEYS

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

// Retention: read notifications older than `olderThanDays` are deleted in
// batches (a few hundred new notifications a day accumulate with ~230 symbols).
// Unread ones are never touched. `maxBatches` bounds one run's work.
export async function deleteOldReadNotifications({ olderThanDays = 30, maxBatches = 20, now = new Date() } = {}) {
  const cutoff = admin.firestore.Timestamp.fromDate(new Date(now.getTime() - olderThanDays * 24 * 60 * 60 * 1000))
  let deleted = 0
  for (let i = 0; i < maxBatches; i++) {
    const snapshot = await db.collection(NOTIFICATIONS_COLLECTION).where('read', '==', true).where('createdAt', '<', cutoff).limit(BATCH_LIMIT).get()
    if (snapshot.empty) break
    const batch = db.batch()
    snapshot.docs.forEach((doc) => batch.delete(doc.ref))
    await batch.commit()
    deleted += snapshot.size
  }
  return deleted
}

// Read-only twin of deleteOldReadNotifications, used to preview/verify.
export async function countOldReadNotifications({ olderThanDays = 30, now = new Date() } = {}) {
  const cutoff = admin.firestore.Timestamp.fromDate(new Date(now.getTime() - olderThanDays * 24 * 60 * 60 * 1000))
  const snapshot = await db.collection(NOTIFICATIONS_COLLECTION).where('read', '==', true).where('createdAt', '<', cutoff).count().get()
  return snapshot.data().count
}
