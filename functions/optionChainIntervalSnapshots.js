/**
 * Per-interval option-chain snapshots and the (non-AI) change between them.
 *
 * Every 15-minute tick a compact snapshot (ATM +/- N strikes: LTP, OI, IV per
 * side) is stored for each optionable scanner symbol. A notification card's
 * hover then diffs the snapshot at the card's bar against the one a card-interval
 * earlier: previous, current, difference and % change, flagged at +/-5%.
 * Groww has no historical option chain, so only ticks after deployment exist.
 * Snapshots hold EVERY strike of the nearest expiry and are kept permanently
 * (nothing schedules deleteOldSnapshots); every tick also writes a tick-log doc.
 *
 * The pure helpers (tick keys, expiry pick, compaction, diff) are exported for
 * offline tests; the Firestore + Groww parts are at the bottom.
 */

import axios from 'axios'
import { fetchFilteredOptionChain } from './growwOptionChain.js'
import { paced } from './growwPacer.js'

export const SNAPSHOT_COLLECTION = 'optionChainIntervalSnapshots'
export const META_COLLECTION = 'optionChainIntervalMeta'
export const TICK_LOG_COLLECTION = 'optionChainTickLog'
// The hover shows ATM +/- this many strikes unless "all strikes" is asked for.
export const DEFAULT_VIEW_STRIKES_EACH_SIDE = 10
// Stock monthly expiries are shared across stocks; used when Groww returns no expiries for one.
export const REFERENCE_STOCK = 'RELIANCE'
export const DEFAULT_THRESHOLD_PCT = 5
const TICK_SECONDS = 900
const IST_OFFSET = 19800
const GROWW_API_BASE_URL = 'https://api.groww.in/v1'

// Seconds each card interval looks back for its "previous" snapshot.
export const LOOKBACK_SECONDS = { '15minute': 900, '1hour': 3600, '4hour': 14400, '1day': 86400, '1week': 7 * 86400 }

// Metric key in a stored snapshot -> label in the diff rows.
const DIFF_METRICS = [['oi', 'OI'], ['ltp', 'LTP'], ['iv', 'IV'], ['delta', 'Delta'], ['gamma', 'Gamma'], ['theta', 'Theta'], ['vega', 'Vega'], ['rho', 'Rho']]

const round = (n, dp = 2) => (Number.isFinite(n) ? Math.round(n * 10 ** dp) / 10 ** dp : null)
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null)

/** Floors epoch seconds to its 15-minute tick. */
export function tickOf(seconds) {
  return seconds - (seconds % TICK_SECONDS)
}

/** Snapshot ticks: 09:15, 09:30 ... 15:30 IST (the cron already limits weekdays). */
export function isOptionChainTick(now = new Date()) {
  const ist = new Date(now.getTime() + IST_OFFSET * 1000)
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes()
  return minutes >= 9 * 60 + 15 && minutes <= 15 * 60 + 30 + 2
}

/** The tick expected right before `tick` on the same IST day, or null for the first tick (09:15). */
export function previousExpectedTick(tick) {
  const ist = new Date((tick + IST_OFFSET) * 1000)
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes()
  return minutes <= 9 * 60 + 15 ? null : tick - TICK_SECONDS
}

/** Keeps only ATM +/- `each` strikes (by price rank around `spot`) of diff rows. */
export function limitRowsToAtm(rows, spot, each) {
  const strikes = [...new Set(rows.map((r) => r.strike))].sort((a, b) => a - b)
  if (each == null || strikes.length <= 2 * each + 1) return { rows, totalStrikes: strikes.length }
  let atm = 0
  strikes.forEach((p, i) => {
    if (Math.abs(p - spot) < Math.abs(strikes[atm] - spot)) atm = i
  })
  const keep = new Set(strikes.slice(Math.max(0, atm - each), atm + each + 1))
  return { rows: rows.filter((r) => keep.has(r.strike)), totalStrikes: strikes.length }
}

export const snapshotId = (symbol, tick) => `${symbol}_${tick}`

export function istDateString(date = new Date()) {
  return new Date(date.getTime() + IST_OFFSET * 1000).toISOString().slice(0, 10)
}

/** Nearest expiry on/after `today` (YYYY-MM-DD) from either Groww response shape. */
export function pickNearestExpiry(data, today) {
  const list = data?.payload?.expiries ?? data?.payload?.expiry_dates ?? data?.expiries ?? data?.expiry_dates ?? []
  const dates = list.map((d) => String(d).slice(0, 10)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= today).sort()
  return dates[0] ?? null
}

/**
 * A Groww chain -> compact (every strike, or ATM +/- `each` when given), Firestore-safe array
 * (no dotted map keys). `strikes` is the {strikePrice: {CE, PE}} map.
 */
export function compactChain(strikes, underlyingLtp, each = null) {
  const prices = Object.keys(strikes || {}).map(Number).filter(Number.isFinite).sort((a, b) => a - b)
  if (prices.length === 0) return []
  let atm = 0
  prices.forEach((p, i) => {
    if (Math.abs(p - underlyingLtp) < Math.abs(prices[atm] - underlyingLtp)) atm = i
  })
  const side = (leg) =>
    leg
      ? {
          ltp: num(leg.ltp),
          oi: num(leg.open_interest),
          iv: num(leg.greeks?.iv),
          delta: num(leg.greeks?.delta),
          gamma: num(leg.greeks?.gamma),
          theta: num(leg.greeks?.theta),
          vega: num(leg.greeks?.vega),
          rho: num(leg.greeks?.rho),
        }
      : null
  const picked = each == null ? prices : prices.slice(Math.max(0, atm - each), atm + each + 1)
  return picked.map((p) => {
    const data = strikes[String(p)] ?? strikes[p.toFixed(1)] ?? {}
    return { strike: p, ce: side(data.CE), pe: side(data.PE) }
  })
}

/**
 * Plain-arithmetic change between two compact snapshots.
 * One row per strike x side x metric present in either: prev, curr, diff,
 * pct (null when prev is 0/missing) and flag (|pct| >= threshold).
 */
export function buildOptionChainDiff(prev, curr, thresholdPct = DEFAULT_THRESHOLD_PCT) {
  const index = (snap) => new Map((snap?.strikes || []).map((s) => [s.strike, s]))
  const before = index(prev)
  const after = index(curr)
  const strikes = [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => a - b)
  const rows = []
  for (const strike of strikes) {
    for (const [side, label] of [['ce', 'CE'], ['pe', 'PE']]) {
      for (const [metric, name] of DIFF_METRICS) {
        const p = before.get(strike)?.[side]?.[metric] ?? null
        const c = after.get(strike)?.[side]?.[metric] ?? null
        if (p == null && c == null) continue
        const diff = p != null && c != null ? round(c - p, 4) : null
        const pct = diff != null && p ? round((diff / p) * 100, 2) : null
        rows.push({ strike, side: label, metric: name, prev: p, curr: c, diff, pct, flag: pct != null && Math.abs(pct) >= thresholdPct })
      }
    }
  }
  return rows
}

// ---------- Groww + Firestore (runtime only) ----------

async function fetchExpiryList({ exchange, symbol, groww_token }) {
  const response = await paced(() =>
    axios.get(`${GROWW_API_BASE_URL}/historical/expiries`, {
      headers: { Authorization: `Bearer ${groww_token}`, 'X-API-VERSION': '1.0', Accept: 'application/json' },
      params: { exchange, underlying_symbol: symbol },
      timeout: 15000,
    })
  )
  return response.data
}

/**
 * Nearest expiry for a symbol. Groww's expiry list is empty for a few valid
 * underlyings (seen: M&M, GVT&D), while their chain works for the shared stock
 * expiry dates - so stocks fall back to a reference stock's expiries
 * (`reference` caches that per day). Indices have their own dates: no fallback.
 */
async function fetchNearestExpiry({ exchange, symbol, isIndex, groww_token, today, meta }) {
  const own = pickNearestExpiry(await fetchExpiryList({ exchange, symbol, groww_token }), today)
  if (own || isIndex) return own
  if (!meta.reference) {
    meta.reference = pickNearestExpiry(await fetchExpiryList({ exchange, symbol: REFERENCE_STOCK, groww_token }), today)
    meta.dirty = true
  }
  return meta.reference
}

/**
 * One tick: snapshot every optionable symbol. `db` is the scanner Firestore,
 * `symbols` the scanner entries, `optionable` a Set of underlying names.
 * Expiries are cached in Firestore for the IST day so a tick costs one Groww
 * call per symbol (the chain), not two.
 */
export async function runOptionChainSnapshotTick({ db, symbols, optionable, groww_token, now = new Date(), concurrency = 3, strikesEachSide = null, deadline = Infinity }) {
  const startedAtMs = Date.now()
  const tick = tickOf(Math.floor(now.getTime() / 1000))
  const today = istDateString(now)
  const targets = symbols.filter((s) => optionable.has(s.symbol))

  // A gap in the schedule: the previous tick of the day left no log doc.
  const previous = previousExpectedTick(tick)
  let missedPrevious = false
  if (previous != null) {
    missedPrevious = !(await db.collection(TICK_LOG_COLLECTION).doc(String(previous)).get()).exists
    if (missedPrevious) console.error(`optionChainSnapshots: previous tick ${previous} has no log - it was missed`)
  }

  const metaRef = db.collection(META_COLLECTION).doc('expiries')
  const metaSnap = await metaRef.get()
  const stored = metaSnap.exists && metaSnap.data().date === today ? metaSnap.data() : { date: today, map: {} }
  const meta = { date: today, map: stored.map || {}, reference: stored.reference ?? null, dirty: false }

  const stats = { tick, targets: targets.length, saved: 0, failed: 0, skipped: 0 }
  const failedSymbols = []

  const snapshotOne = async (entry) => {
    let expiry = meta.map[entry.symbol]
    if (!expiry) {
      expiry = await fetchNearestExpiry({ exchange: entry.exchange, symbol: entry.symbol, isIndex: entry.isIndex, groww_token, today, meta })
      if (!expiry) throw new Error('no upcoming expiry')
      meta.map[entry.symbol] = expiry
      meta.dirty = true
    }
    const chain = await paced(() =>
      fetchFilteredOptionChain({ exchange: entry.exchange, underlying_symbol: entry.symbol, expiry_date: expiry, points_range: 1e9, groww_token })
    )
    const strikes = compactChain(chain.filtered_strikes, chain.underlying_ltp, strikesEachSide)
    await db.collection(SNAPSHOT_COLLECTION).doc(snapshotId(entry.symbol, tick)).set({
      symbol: entry.symbol,
      exchange: entry.exchange,
      expiry,
      tick,
      underlyingLtp: chain.underlying_ltp,
      strikes,
      createdAt: new Date(),
    })
  }

  let next = 0
  const worker = async () => {
    while (next < targets.length) {
      const entry = targets[next++]
      if (Date.now() > deadline) {
        stats.skipped++
        continue
      }
      // Two attempts inside the same tick; a failed attempt drops the cached expiry
      // (it may have rolled over) so the retry looks it up again.
      let lastError = null
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          await snapshotOne(entry)
          lastError = null
          break
        } catch (error) {
          lastError = error
          if (meta.map[entry.symbol]) {
            delete meta.map[entry.symbol]
            meta.dirty = true
          }
          if (Date.now() > deadline) break
        }
      }
      if (lastError) {
        stats.failed++
        failedSymbols.push(entry.symbol)
        console.error(`optionChainSnapshots: ${entry.symbol} failed:`, lastError.details?.message || lastError.message)
      } else stats.saved++
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker))
  if (meta.dirty) await metaRef.set({ date: meta.date, map: meta.map, reference: meta.reference })
  await db.collection(TICK_LOG_COLLECTION).doc(String(tick)).set({ ...stats, failedSymbols, missedPrevious, startedAt: now, durationMs: Date.now() - startedAtMs })
  return { ...stats, failedSymbols, missedPrevious }
}

/** Latest snapshot of `symbol` at or before `tickLimit`, no older than `maxAgeSeconds`. */
export async function readSnapshotAtOrBefore(db, symbol, tickLimit, maxAgeSeconds = 2 * TICK_SECONDS) {
  const result = await db
    .collection(SNAPSHOT_COLLECTION)
    .where('symbol', '==', symbol)
    .where('tick', '<=', tickLimit)
    .orderBy('tick', 'desc')
    .limit(1)
    .get()
  if (result.empty) return null
  const data = result.docs[0].data()
  return tickLimit - data.tick <= maxAgeSeconds ? data : null
}

/**
 * The diff for one card: snapshot at the card's bar end vs the one a
 * card-interval earlier. Returns {hasData, reason?, ...}.
 */
export async function getCardOptionChainDiff({ db, symbol, interval, barEnd, thresholdPct = DEFAULT_THRESHOLD_PCT, strikesEachSide = DEFAULT_VIEW_STRIKES_EACH_SIDE }) {
  const lookback = LOOKBACK_SECONDS[interval]
  if (!lookback || barEnd == null) return { hasData: false, reason: 'unsupported-interval' }
  const currTick = tickOf(barEnd)
  const curr = await readSnapshotAtOrBefore(db, symbol, currTick)
  if (!curr) return { hasData: false, reason: 'no-snapshot' }
  // Previous: the newest snapshot at/before (curr - lookback); for daily/weekly
  // allow extra slack so weekends and holidays still resolve to the prior session.
  const slack = lookback >= 86400 ? 4 * 86400 : 2 * TICK_SECONDS
  const prev = await readSnapshotAtOrBefore(db, symbol, curr.tick - lookback, slack)
  if (!prev) return { hasData: false, reason: 'no-previous', currTick: curr.tick }
  return {
    hasData: true,
    symbol,
    thresholdPct,
    expiry: curr.expiry,
    expiryChanged: prev.expiry !== curr.expiry,
    prevTick: prev.tick,
    currTick: curr.tick,
    prevUnderlying: prev.underlyingLtp,
    currUnderlying: curr.underlyingLtp,
    ...limitRowsToAtm(buildOptionChainDiff(prev, curr, thresholdPct), curr.underlyingLtp, strikesEachSide),
    strikesEachSide,
  }
}

/**
 * Manual clean-up only (NOT scheduled - snapshots are kept permanently):
 * deletes snapshots older than `olderThanDays`, in batches.
 */
export async function deleteOldSnapshots(db, { olderThanDays, now = new Date(), maxBatches = 20 }) {
  if (!Number.isFinite(olderThanDays) || olderThanDays < 1) throw new Error('olderThanDays is required')
  const cutoff = Math.floor(now.getTime() / 1000) - olderThanDays * 86400
  let deleted = 0
  for (let i = 0; i < maxBatches; i++) {
    const snap = await db.collection(SNAPSHOT_COLLECTION).where('tick', '<', cutoff).limit(400).get()
    if (snap.empty) break
    const batch = db.batch()
    snap.docs.forEach((d) => batch.delete(d.ref))
    await batch.commit()
    deleted += snap.size
    if (snap.size < 400) break
  }
  return deleted
}
