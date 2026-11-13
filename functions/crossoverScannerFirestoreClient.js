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
import { DEFAULT_GROUP_ORDER, DEFAULT_GROUP_SORT, isDefaultGroupOrder, sortGroups } from './crossoverGroupSort.js'
import { DEFAULT_ENABLED_INTERVALS, DEFAULT_POPUP_INTERVALS, DEFAULT_MIN_AGREEMENT, SETTINGS_VERSION, candleStartRangeForEndRange } from './crossoverTimeframes.js'

const PROJECT_ID = 'dev-cogniglob'
const DATABASE_ID = 'groww-dashboard'

if (admin.apps.length === 0) {
  admin.initializeApp({ projectId: PROJECT_ID })
}

const db = getFirestore(admin.app(), DATABASE_ID)

const SYMBOLS_COLLECTION = 'crossoverScannerSymbols'
const NOTIFICATIONS_COLLECTION = 'historicalWatchlistNotifications'
// One doc per symbol + timeframe + crossover bar, merging every indicator that
// crossed on that bar (the Notifications page's cards). See upsertCrossoverGroup.
const GROUPS_COLLECTION = 'crossoverGroups'
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

// ---------- display order + index detection ----------

// Symbols without an explicit list position sort after every listed one.
export const UNLISTED_SORT_ORDER = 100000

// NSE index symbols (instrument_type IDX). Used only when the instrument master
// has no instrumentType for the symbol (docs synced before that field existed).
const INDEX_SYMBOL_PATTERN = /^(NIFTY|BANKNIFTY|FINNIFTY|MIDCPNIFTY|SENSEX|BANKEX)/
const ETF_SUFFIX_PATTERN = /(BEES|ETF|IETF)$/

export function isIndexSymbol(symbol, instrumentType) {
  if (instrumentType) return instrumentType === 'IDX'
  return INDEX_SYMBOL_PATTERN.test(symbol) && !ETF_SUFFIX_PATTERN.test(symbol)
}

// Indices first, then the uploaded list order, then alphabetical.
export function compareSymbolOrder(a, b) {
  const ai = (a.isIndex ?? isIndexSymbol(a.symbol)) ? 0 : 1
  const bi = (b.isIndex ?? isIndexSymbol(b.symbol)) ? 0 : 1
  return ai - bi || (a.sortOrder ?? UNLISTED_SORT_ORDER) - (b.sortOrder ?? UNLISTED_SORT_ORDER) || a.symbol.localeCompare(b.symbol)
}

// Deterministic id (exchange + symbol) makes add idempotent and lets DELETE
// address a symbol without a lookup.
export function scannerSymbolId(exchange, symbol) {
  return `${exchange}_${symbol}`
}

// ---------- symbol list (one list for every timeframe) ----------

// No orderBy on the query (so no composite index needed) - the list is tiny,
// sorted in memory: indices first, then the uploaded list order (sortOrder).
export async function listActiveScannerSymbols() {
  const snapshot = await db.collection(SYMBOLS_COLLECTION).where('active', '==', true).get()
  return snapshot.docs.map(serializeSymbolDoc).sort(compareSymbolOrder)
}

// Idempotent: re-adding an existing symbol just reactivates it (clearing any
// soft-delete) instead of creating a duplicate.
export async function addScannerSymbol({ symbol, exchange = 'NSE', source = 'manual', instrumentType = null }) {
  const id = scannerSymbolId(exchange, symbol)
  const ref = db.collection(SYMBOLS_COLLECTION).doc(id)
  const existing = await ref.get()
  const isIndex = isIndexSymbol(symbol, instrumentType)
  if (existing.exists) {
    await ref.update({ active: true, isIndex })
    return { id, created: !existing.data().active }
  }
  await ref.set({
    symbol,
    exchange,
    source,
    isIndex,
    sortOrder: UNLISTED_SORT_ORDER,
    active: true,
    scanState: {},
    lastError: null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  })
  return { id, created: true }
}

/**
 * Applies a display order (e.g. Sheet1 of the notification list): each listed
 * symbol gets its position (first occurrence wins), every other symbol doc
 * gets UNLISTED_SORT_ORDER + its alphabetical rank. Then copies sortOrder /
 * isIndex onto the last `groupDays` days of crossover groups so existing cards
 * re-sort too. Returns {ordered, unlisted, groupsUpdated}.
 */
// Names the notification-list sheet uses for symbols Groww spells differently
// (indices) - other truncated names (BAJAJ, GVT, NAM) resolve by prefix below.
export const LIST_SYMBOL_ALIASES = { MIDCPNIFTY: 'NIFTYMIDSELECT', NIFTYNXT: 'NIFTYJR' }

// A list name -> the scanner's symbol: exact, alias, or the one symbol whose
// part before '-' / '&' matches (BAJAJ -> BAJAJ-AUTO, GVT -> GVT&D, NAM -> NAM-INDIA).
export function resolveListSymbol(name, knownSymbols) {
  if (knownSymbols.has(name)) return name
  if (LIST_SYMBOL_ALIASES[name] && knownSymbols.has(LIST_SYMBOL_ALIASES[name])) return LIST_SYMBOL_ALIASES[name]
  const byPrefix = [...knownSymbols].filter((s) => /[-&]/.test(s) && s.split(/[-&]/)[0] === name)
  return byPrefix.length === 1 ? byPrefix[0] : null
}

export async function setSymbolOrder(orderedSymbols, { groupDays = 30, now = new Date() } = {}) {
  const snapshot = await db.collection(SYMBOLS_COLLECTION).get()
  const known = new Set(snapshot.docs.map((d) => d.data().symbol))
  const position = new Map()
  const unresolved = []
  for (const raw of orderedSymbols) {
    const name = String(raw).trim().toUpperCase()
    if (!name) continue
    const symbol = resolveListSymbol(name, known)
    if (!symbol) unresolved.push(name)
    else if (!position.has(symbol)) position.set(symbol, position.size)
  }
  const unlisted = snapshot.docs.filter((d) => !position.has(d.data().symbol)).sort((a, b) => a.data().symbol.localeCompare(b.data().symbol))
  const unlistedRank = new Map(unlisted.map((d, i) => [d.id, i]))

  const bySymbol = new Map()
  const updates = snapshot.docs.map((doc) => {
    const { symbol } = doc.data()
    const sortOrder = position.has(symbol) ? position.get(symbol) : UNLISTED_SORT_ORDER + unlistedRank.get(doc.id)
    const isIndex = doc.data().isIndex ?? isIndexSymbol(symbol)
    bySymbol.set(symbol, { sortOrder, isIndex })
    return { ref: doc.ref, patch: { sortOrder, isIndex } }
  })
  await commitInBatches(updates, (batch, { ref, patch }) => batch.update(ref, patch))

  const cutoff = Math.floor(now.getTime() / 1000) - groupDays * 24 * 60 * 60
  const groups = await db.collection(GROUPS_COLLECTION).where('candleTimestamp', '>=', cutoff).get()
  const groupUpdates = groups.docs
    .map((doc) => ({ ref: doc.ref, data: doc.data() }))
    .filter(({ data }) => bySymbol.has(data.symbol))
    .map(({ ref, data }) => ({ ref, patch: bySymbol.get(data.symbol), data }))
    .filter(({ patch, data }) => patch.sortOrder !== data.sortOrder || patch.isIndex !== data.isIndex)
  await commitInBatches(groupUpdates, (batch, { ref, patch }) => batch.update(ref, patch))

  return { ordered: position.size, unresolved, unlisted: unlisted.map((d) => d.data().symbol), groupsUpdated: groupUpdates.length }
}

async function commitInBatches(items, apply) {
  for (let i = 0; i < items.length; i += BATCH_LIMIT) {
    const batch = db.batch()
    items.slice(i, i + BATCH_LIMIT).forEach((item) => apply(batch, item))
    await batch.commit()
  }
}

// NRML margin shown on the Notifications cards and in the export; edited on the
// Scanner page. null clears it.
export async function setScannerSymbolMargin(id, nrmlMargin) {
  const ref = db.collection(SYMBOLS_COLLECTION).doc(id)
  const snapshot = await ref.get()
  if (!snapshot.exists) return false
  await ref.update({ nrmlMargin })
  return true
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
      isIndex: entry.isIndex ?? isIndexSymbol(entry.symbol),
      sortOrder: entry.sortOrder ?? UNLISTED_SORT_ORDER,
      intervals: Object.fromEntries(
        Object.entries(entry.scanState || {}).map(([interval, state]) => [
          interval,
          { lastBarEnd: state.lastBarEnd ?? null, lastScanAt: state.lastScanAt ?? null, lastError: state.lastError ?? null, summary: state.summary ?? null },
        ])
      ),
    }))
    .sort(compareSymbolOrder)
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

// Short lease so two manual "Run now" requests can't overlap (a scheduled tick
// overlapping a manual run is harmless - every write is idempotent). Returns
// false when another manual run holds the lease.
export async function acquireManualRunLease(leaseMs, now = new Date()) {
  const ref = db.collection(APP_CONFIG_COLLECTION).doc(STATUS_DOC)
  return db.runTransaction(async (tx) => {
    const doc = await tx.get(ref)
    const until = doc.exists ? doc.data().manualRunLockUntil : null
    if (until && Date.parse(until) > now.getTime()) return false
    tx.set(ref, { manualRunLockUntil: new Date(now.getTime() + leaseMs).toISOString() }, { merge: true })
    return true
  })
}

export async function releaseManualRunLease() {
  await db.collection(APP_CONFIG_COLLECTION).doc(STATUS_DOC).set({ manualRunLockUntil: null }, { merge: true })
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

// ---------- crossover groups (one card per symbol + timeframe + bar) ----------

export function crossoverGroupId({ exchange, symbol, interval, candleTimestamp }) {
  return `xg_${exchange}_${symbol}_${interval}_${candleTimestamp}`
}

// Every crossover of one symbol/timeframe/bar comes out of one scan call, so
// the group is built in memory and written whole. A first write creates it
// unread; a re-write (a retried scan of the same bar) refreshes the content
// but keeps `read` and `createdAt`.
export async function upsertCrossoverGroup(id, fields) {
  const ref = db.collection(GROUPS_COLLECTION).doc(id)
  try {
    await ref.create({ ...fields, read: false, createdAt: admin.firestore.FieldValue.serverTimestamp() })
    return true
  } catch (error) {
    if (error.code !== ALREADY_EXISTS_CODE) throw error
    await ref.set(fields, { merge: true })
    return false
  }
}

// Notifications predating the ADX -> DMI rename carry the old label (until
// scripts/migrateAdxToDmi.mjs has run) - a filter on either label matches both.
export const LEGACY_INDICATOR_LABELS = { 'DMI 14 (+DI/-DI)': ['ADX 14 (+DI/-DI)'] }
export function expandIndicatorLabels(labels) {
  return [...new Set(labels.flatMap((label) => [label, ...(LEGACY_INDICATOR_LABELS[label] || [])]))]
}

// One timeframe's groups for either the index symbols or the rest, with the
// page filters. Ordered newest bar first, then list order (sortOrder).
// Indexes: crossoverGroups composites in firestore.indexes.json.
function groupQuery(section, isIndex, { type, unreadOnly, indicator, direction, symbol, adx, from, to } = {}) {
  if (type && type !== 'crossover') return null
  let query = db.collection(GROUPS_COLLECTION).where('interval', '==', section).where('isIndex', '==', isIndex)
  if (adx) query = query.where('adxTrend', '==', adx)
  if (unreadOnly) query = query.where('read', '==', false)
  if (symbol) query = query.where('symbol', '==', symbol)
  if (direction === 'bullish') query = query.where('hasBullish', '==', true)
  if (direction === 'bearish') query = query.where('hasBearish', '==', true)
  if (indicator?.length) query = query.where('indicatorLabels', 'array-contains-any', expandIndicatorLabels(indicator))
  const { gte, lte } = candleStartRangeForEndRange(section, from ? Math.floor(Date.parse(from) / 1000) : null, to ? Math.floor(Date.parse(to) / 1000) : null)
  if (gte !== undefined) query = query.where('candleTimestamp', '>=', gte)
  if (lte !== undefined) query = query.where('candleTimestamp', '<=', lte)
  return query.orderBy('candleTimestamp', 'desc').orderBy('sortOrder', 'asc')
}

function serializeGroupDoc(doc) {
  const data = doc.data()
  return { id: doc.id, ...data, createdAt: data.createdAt?.toDate?.().toISOString() || null }
}

// Most groups read into memory for a non-default sort of one timeframe slice.
export const SORT_CAP = 2000

/**
 * One numbered page of a timeframe's crossover groups, optionally just the
 * Indices or just the Stocks slice (`group`). Without `group`, index groups come
 * first. The page is an offset window over the chosen slices, so totals are
 * exact and nothing repeats across pages. Default order is newest bar first;
 * other `sort`/`order` values are applied in memory (see crossoverGroupSort.js).
 */
export async function queryCrossoverGroupsPage(section, filters = {}, { page = 1, pageSize = 25, group = null, sort = DEFAULT_GROUP_SORT, order = DEFAULT_GROUP_ORDER, margins = null } = {}) {
  if (!DEFAULT_ENABLED_INTERVALS.includes(section)) return { items: [], total: 0, indexTotal: 0, capped: false }
  // group: 'index' | 'stock' = just that slice; anything else = both (indices first).
  // group 'all' = both slices merged by bar time (newest first), indices before stocks within a bar.
  const byBar = group === 'all'
  const flags = group === 'index' ? [true] : group === 'stock' ? [false] : [true, false]
  const queries = flags.map((isIndex) => groupQuery(section, isIndex, filters))
  if (queries.some((q) => !q)) return { items: [], total: 0, indexTotal: 0, capped: false }

  const counts = await Promise.all(queries.map(async (q) => (await q.count().get()).data().count))
  const total = counts.reduce((sum, n) => sum + n, 0)
  const indexTotal = flags[0] === true ? counts[0] : 0
  const start = (page - 1) * pageSize
  const end = start + pageSize

  if (byBar) {
    const snapshots = await Promise.all(queries.map((query) => query.limit(SORT_CAP).get()))
    const sorted = sortGroups(snapshots.flatMap((snap) => snap.docs.map(serializeGroupDoc)), 'timeindex', order)
    return { items: sorted.slice(start, end), total, indexTotal, capped: counts.some((n) => n > SORT_CAP) }
  }

  if (isDefaultGroupOrder(sort, order)) {
    // Newest bar first, then list order - served by Firestore. The page is an
    // offset window over [slice 1 groups..., slice 2 groups...].
    const fetches = []
    let offset = 0
    queries.forEach((query, i) => {
      const sliceStart = offset
      offset += counts[i]
      const from = Math.max(start, sliceStart)
      const to = Math.min(end, offset)
      if (from < to) fetches.push(query.offset(from - sliceStart).limit(to - from).get())
    })
    const snapshots = await Promise.all(fetches)
    return { items: snapshots.flatMap((snap) => snap.docs.map(serializeGroupDoc)), total, indexTotal, capped: false }
  }

  // Any other order: read the newest SORT_CAP groups of each slice, sort in
  // memory, then cut the page out of [sorted slice 1..., sorted slice 2...].
  const snapshots = await Promise.all(queries.map((query) => query.limit(SORT_CAP).get()))
  // NRML margin lives on the scanner symbols, so the caller passes a lookup for that sort.
  const withMargin = (doc) => {
    const item = serializeGroupDoc(doc)
    return sort === 'nrml' && margins ? { ...item, nrmlMargin: margins.get(`${item.exchange}_${item.symbol}`) ?? null } : item
  }
  const sorted = snapshots.flatMap((snap) => sortGroups(snap.docs.map(withMargin), sort, order))
  return { items: sorted.slice(start, end), total, indexTotal, capped: counts.some((n) => n > SORT_CAP) }
}

// One merged card by id, or null.
export async function getCrossoverGroup(id) {
  const snapshot = await db.collection(GROUPS_COLLECTION).doc(id).get()
  return snapshot.exists ? serializeGroupDoc(snapshot) : null
}

export async function markCrossoverGroupsRead(ids) {
  await commitInBatches(ids, (batch, id) => batch.update(db.collection(GROUPS_COLLECTION).doc(id), { read: true }))
  return ids.length
}

// "Mark all read": every unread notification and every unread group, in
// batches (no 500-write limit).
export async function markAllNotificationsAndGroupsRead() {
  let notifications = 0
  for (const collection of [NOTIFICATIONS_COLLECTION, GROUPS_COLLECTION]) {
    for (;;) {
      const snapshot = await db.collection(collection).where('read', '==', false).limit(BATCH_LIMIT).get()
      if (snapshot.empty) break
      const batch = db.batch()
      snapshot.docs.forEach((doc) => batch.update(doc.ref, { read: true }))
      await batch.commit()
      if (collection === NOTIFICATIONS_COLLECTION) notifications += snapshot.size
      if (snapshot.size < BATCH_LIMIT) break
    }
  }
  return notifications
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
  const labels = indicator?.length ? expandIndicatorLabels(indicator) : []
  if (labels.length === 1) query = query.where('indicatorLabel', '==', labels[0])
  else if (labels.length > 1) query = query.where('indicatorLabel', 'in', labels)
  if (direction) query = query.where('direction', '==', direction)
  if (symbol) query = query.where('symbol', '==', symbol)
  // Optional date range. Timeframe sections filter on the crossover's own bar time
  // (what the page shows as "Crossed ..."), NOT createdAt: back-filled/late-scanned crossovers are written long after they
  // happened. System warnings have no bar, so they use createdAt.
  if (section === SYSTEM_SECTION) {
    if (from) query = query.where('createdAt', '>=', admin.firestore.Timestamp.fromDate(new Date(from)))
    if (to) query = query.where('createdAt', '<=', admin.firestore.Timestamp.fromDate(new Date(to)))
  } else {
    // The user's range is on the DISPLAYED time (bar end); candleTimestamp is the
    // bar start, so translate the range (see candleStartRangeForEndRange).
    const { gte, lte } = candleStartRangeForEndRange(section, from ? Math.floor(Date.parse(from) / 1000) : null, to ? Math.floor(Date.parse(to) / 1000) : null)
    if (gte !== undefined) query = query.where('candleTimestamp', '>=', gte)
    if (lte !== undefined) query = query.where('candleTimestamp', '<=', lte)
  }
  return query
}

// The field a section is ordered (and range-filtered) by: the bar start for
// timeframe sections (same order as bar end), createdAt for System.
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
// The ADX status lives on the merged cards (crossoverGroups), not on the
// per-indicator notifications, so with that filter a timeframe section is
// counted in cards (index + stock cards) to match the list underneath it.
async function countGroupsForSection(section, filters) {
  const sum = async (extra) => {
    const queries = [true, false].map((isIndex) => groupQuery(section, isIndex, { ...filters, ...extra }))
    if (queries.some((q) => !q)) return 0
    const counts = await Promise.all(queries.map(async (q) => (await q.count().get()).data().count))
    return counts[0] + counts[1]
  }
  const newest = async () => {
    const queries = [true, false].map((isIndex) => groupQuery(section, isIndex, filters))
    if (queries.some((q) => !q)) return null
    const snaps = await Promise.all(queries.map((q) => q.limit(1).get()))
    const stamps = snaps.flatMap((snap) => snap.docs.map((d) => d.data().candleTimestamp)).filter((t) => t != null)
    return stamps.length ? Math.max(...stamps) : null
  }
  const [total, unread, bullish, bearish, unreadBullish, unreadBearish, lastCrossover] = await Promise.all([
    sum({}),
    sum({ unreadOnly: true }),
    sum({ direction: 'bullish' }),
    sum({ direction: 'bearish' }),
    sum({ direction: 'bullish', unreadOnly: true }),
    sum({ direction: 'bearish', unreadOnly: true }),
    newest(),
  ])
  return { total, unread, bullish, bearish, unreadBullish, unreadBearish, lastCrossover }
}

async function countSectionNotifications(filters = {}) {
  const entries = await Promise.all(
    SECTION_KEYS.map(async (section) => {
      if (filters.adx) {
        if (section === SYSTEM_SECTION || (filters.type && filters.type !== 'crossover')) return [section, { total: 0, unread: 0, bullish: 0, bearish: 0, unreadBullish: 0, unreadBearish: 0, lastCrossover: null }]
        return [section, await countGroupsForSection(section, filters)]
      }
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

// Cards in the Indices / Stocks slice of a timeframe under the page filters
// (the numbers on the two sub-sections).
async function countGroupSlices(section, filters) {
  const queries = [true, false].map((isIndex) => groupQuery(section, isIndex, filters))
  if (queries.some((q) => !q)) return { indexTotal: 0, stockTotal: 0 }
  const [indexTotal, stockTotal] = await Promise.all(queries.map(async (q) => (await q.count().get()).data().count))
  return { indexTotal, stockTotal }
}

export async function countNotificationsBySection(filters = {}) {
  const sections = await countSectionNotifications(filters)
  const slices = await Promise.all(DEFAULT_ENABLED_INTERVALS.map((section) => countGroupSlices(section, filters)))
  DEFAULT_ENABLED_INTERVALS.forEach((section, i) => {
    if (sections[section]) Object.assign(sections[section], slices[i])
  })
  return sections
}

// ---------- bulk delete (Notifications page "Delete notifications") ----------

// Notifications in the given sections created within [from, to]. Each section is
// its own equality + range query (candleTimestamp, or createdAt for System), so
// the (interval, ..., candleTimestamp) indexes serve it. `maxDocs` bounds one request's work; `hasMore` tells the
// caller to repeat.
function deleteQueries(sections, from, to) {
  return sections.map((section) => sectionQuery(section, { from, to })).filter(Boolean)
}

export async function countNotificationsForDelete({ sections, from, to, includeGroups = false }) {
  const queries = [...deleteQueries(sections, from, to), ...(includeGroups ? groupDeleteQueries(sections, from, to) : [])]
  const counts = await Promise.all(queries.map(async (q) => (await q.count().get()).data().count))
  return counts.reduce((sum, n) => sum + n, 0)
}

// The crossover groups behind the same date range (timeframe sections only).
function groupDeleteQueries(sections, from, to) {
  return sections
    .filter((section) => section !== SYSTEM_SECTION)
    .map((section) => {
      const { gte, lte } = candleStartRangeForEndRange(section, Math.floor(Date.parse(from) / 1000), Math.floor(Date.parse(to) / 1000))
      let query = db.collection(GROUPS_COLLECTION).where('interval', '==', section)
      if (gte !== undefined) query = query.where('candleTimestamp', '>=', gte)
      if (lte !== undefined) query = query.where('candleTimestamp', '<=', lte)
      return query
    })
}

export async function deleteNotificationsInRange({ sections, from, to, maxBatches = 20 }) {
  let deleted = 0
  let batches = 0
  for (const query of [...deleteQueries(sections, from, to), ...groupDeleteQueries(sections, from, to)]) {
    while (batches < maxBatches) {
      const snapshot = await query.limit(BATCH_LIMIT).get()
      if (snapshot.empty) break
      const batch = db.batch()
      snapshot.docs.forEach((doc) => batch.delete(doc.ref))
      await batch.commit()
      if (snapshot.docs[0].ref.parent.id === NOTIFICATIONS_COLLECTION) deleted += snapshot.size
      batches += 1
      if (snapshot.size < BATCH_LIMIT) break
    }
    if (batches >= maxBatches) break
  }
  const remaining = batches >= maxBatches ? await countNotificationsForDelete({ sections, from, to, includeGroups: true }) : 0
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
  for (const collection of [NOTIFICATIONS_COLLECTION, GROUPS_COLLECTION]) {
    for (let i = 0; i < maxBatches; i++) {
      const snapshot = await db.collection(collection).where('read', '==', true).where('createdAt', '<', cutoff).limit(BATCH_LIMIT).get()
      if (snapshot.empty) break
      const batch = db.batch()
      snapshot.docs.forEach((doc) => batch.delete(doc.ref))
      await batch.commit()
      if (collection === NOTIFICATIONS_COLLECTION) deleted += snapshot.size
      if (snapshot.size < BATCH_LIMIT) break
    }
  }
  return deleted
}

// Read-only twin of deleteOldReadNotifications, used to preview/verify.
export async function countOldReadNotifications({ olderThanDays = 30, now = new Date() } = {}) {
  const cutoff = admin.firestore.Timestamp.fromDate(new Date(now.getTime() - olderThanDays * 24 * 60 * 60 * 1000))
  const snapshot = await db.collection(NOTIFICATIONS_COLLECTION).where('read', '==', true).where('createdAt', '<', cutoff).count().get()
  return snapshot.data().count
}

// ---------- Excel export ----------

// Runs `fn` over `items` with at most `limit` in flight.
async function mapPool(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/**
 * Fallback for the export: the newest crossover card for each {entry, interval}
 * pair (symbols whose scan summary is missing). One `limit(1)` query per pair on
 * the interval+isIndex+symbol+candleTimestamp index, optionally inside from/to.
 * Returns Map(`${exchange}_${symbol}_${interval}` -> card).
 */
export async function listLatestGroupsForPairs(pairs, { from, to } = {}) {
  const latest = new Map()
  await mapPool(pairs, 40, async ({ entry, interval }) => {
    const query = groupQuery(interval, Boolean(entry.isIndex), { symbol: entry.symbol, from, to })
    if (!query) return
    const doc = (await query.limit(1).get()).docs[0]
    if (!doc) return
    const card = serializeGroupDoc(doc)
    if (card.exchange === entry.exchange) latest.set(`${card.exchange}_${card.symbol}_${card.interval}`, card)
  })
  return latest
}

// Newest crossover card: {interval, candleTimestamp} or null. Lets the export
// default to the latest day that has data instead of an empty "today".
export async function latestCrossoverGroup() {
  const snapshot = await db.collection(GROUPS_COLLECTION).orderBy('candleTimestamp', 'desc').limit(1).get()
  if (snapshot.empty) return null
  const { interval, candleTimestamp } = snapshot.docs[0].data()
  return { interval, candleTimestamp }
}

// For the one-off maintenance scripts in functions/scripts (migration/backfill).
export const scannerDb = db
export const SCANNER_COLLECTIONS = { symbols: SYMBOLS_COLLECTION, notifications: NOTIFICATIONS_COLLECTION, groups: GROUPS_COLLECTION }
