/**
 * Daily sync of Groww's public instrument master CSV
 * (https://growwapi-assets.groww.in/instruments/instrument.csv, no auth
 * required - confirmed via Groww's trade-api docs) into Firestore, so the
 * Historical Chart's symbol picker can search by company name, not just the
 * bare symbol code (see searchInstruments below, used by the
 * /instrument-search route in functions/index.js / server.js).
 *
 * Deliberately separate from getUnderlyingSymbols()/firestoreClient.js's
 * `underlyingSymbols` doc - that's a small curated list of F&O underlyings
 * shared by Greek Analysis/Compare/Chart's symbol dropdown, used for
 * option-chain features; changing it risks breaking those screens. This
 * covers the much larger plain NSE/BSE cash-equity universe instead, so it
 * gets its own collection.
 *
 * The raw CSV's CASH segment includes thousands of bonds/NCDs alongside
 * real equities (distinguished only by the `series` column, e.g. bond
 * series like "N1"/"NE" vs plain equities' "EQ") - confirmed live
 * (~12.9k CASH rows vs ~2.7k once filtered to series === 'EQ'). Indices
 * (NIFTY, BANKNIFTY, ...) are also segment CASH but instrument_type 'IDX'
 * with an empty `series` - confirmed live (31 rows) - included too since
 * this app's Chart tab has always used indices as its primary test/default
 * symbols; excluding them (series === 'EQ' alone) silently broke picking
 * NIFTY once this search replaced the old picker.
 */

import axios from 'axios'
import { parse } from 'csv-parse/sync'
import admin from 'firebase-admin'
import { getFirestore } from 'firebase-admin/firestore'

const PROJECT_ID = 'dev-cogniglob'
const DATABASE_ID = 'groww-dashboard'

if (admin.apps.length === 0) {
  admin.initializeApp({ projectId: PROJECT_ID })
}

const db = getFirestore(admin.app(), DATABASE_ID)
const INSTRUMENT_MASTER_COLLECTION = 'instrumentMaster'
const INSTRUMENT_CSV_URL = 'https://growwapi-assets.groww.in/instruments/instrument.csv'
const BATCH_SIZE = 400

export async function syncInstrumentMaster() {
  const response = await axios.get(INSTRUMENT_CSV_URL, { timeout: 60000, responseType: 'text' })
  const rows = parse(response.data, { columns: true, skip_empty_lines: true })

  const instrumentRows = rows.filter(
    (row) => row.segment === 'CASH' && (row.series === 'EQ' || row.instrument_type === 'IDX') && row.trading_symbol && row.name
  )

  // Store the BARE trading_symbol (e.g. "RELIANCE"), not groww_symbol (e.g.
  // "NSE-RELIANCE") - every other symbol field in this app (selectedSymbol,
  // getHistoricalCandles, watchlist entries) is the bare code, and
  // growwHistoricalData.js's buildGrowwSymbol() re-prepends the exchange
  // itself (`${exchange}-${symbol}`) when calling Groww - storing the
  // already-prefixed form here would double-prefix it downstream.
  const seen = new Set()
  const docs = []
  for (const row of instrumentRows) {
    if (seen.has(row.trading_symbol)) continue
    seen.add(row.trading_symbol)
    docs.push({ id: row.trading_symbol, symbol: row.trading_symbol, name: row.name, exchange: row.exchange || 'NSE' })
  }

  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = db.batch()
    for (const doc of docs.slice(i, i + BATCH_SIZE)) {
      batch.set(db.collection(INSTRUMENT_MASTER_COLLECTION).doc(doc.id), {
        symbol: doc.symbol,
        name: doc.name,
        exchange: doc.exchange,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      })
    }
    await batch.commit()
  }

  return { totalRows: rows.length, instrumentRows: instrumentRows.length, written: docs.length }
}

// In-memory cache (per warm function instance) of the full instrumentMaster
// collection - Firestore has no native substring/full-text search, but at a
// couple thousand small docs, substring-filtering in memory is cheap and
// avoids re-reading the whole collection on every keystroke of a search.
const CACHE_TTL_MS = 60 * 60 * 1000
let cache = { loadedAt: 0, docs: [] }

async function getInstrumentMasterCached() {
  if (Date.now() - cache.loadedAt < CACHE_TTL_MS && cache.docs.length > 0) return cache.docs
  const snapshot = await db.collection(INSTRUMENT_MASTER_COLLECTION).get()
  cache = { loadedAt: Date.now(), docs: snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })) }
  return cache.docs
}

// Lower is better - Firestore's default doc order is close to alphabetical
// by id, so an unranked substring filter buries an exact/prefix match (e.g.
// "NIFTY" itself) behind dozens of unrelated substring matches (every
// "...NIFTY..." ETF name). Ranks exact symbol match first, then symbol
// prefix, then name prefix, then any other substring hit.
function matchRank(doc, needle) {
  const symbol = doc.symbol.toLowerCase()
  const name = doc.name.toLowerCase()
  if (symbol === needle) return 0
  if (symbol.startsWith(needle)) return 1
  if (name.startsWith(needle)) return 2
  return 3
}

export async function searchInstruments(query, limit = 50) {
  const needle = String(query || '').trim().toLowerCase()
  if (!needle) return []
  const docs = await getInstrumentMasterCached()
  return docs
    .filter((doc) => doc.symbol.toLowerCase().includes(needle) || doc.name.toLowerCase().includes(needle))
    .sort((a, b) => matchRank(a, needle) - matchRank(b, needle) || a.symbol.localeCompare(b.symbol))
    .slice(0, limit)
    .map((doc) => ({ symbol: doc.symbol, name: doc.name, exchange: doc.exchange }))
}
