/**
 * Option-chain context for a chat turn. Two sources, chosen in the Option Chain popup:
 *   live            the Groww chain for symbol + expiry date, fetched now (ATM +/- 10 strikes: LTP, OI, IV, Delta, ...)
 *   saved snapshot  { asOf: {date, time} }: the 15-minute snapshot our scheduler stored at that IST date and time
 *                   (Groww has no historical chain). Scanner symbols only, nearest expiry of that day, no volume.
 * Either goes to the model as a labelled data block. When an earlier snapshot of the same expiry exists, the change
 * since it is included too - the "OI added or unwound" questions need it. `compareWith` picks how far back that
 * earlier snapshot is (15m / 1h / 4h / 1d); live without it uses the latest stored snapshot.
 */

import { fetchFilteredOptionChain } from '../growwOptionChain.js'
import { compactChain, buildOptionChainDiff, readSnapshotAtOrBefore, tickOf, limitRowsToAtm, DEFAULT_VIEW_STRIKES_EACH_SIDE } from '../optionChainIntervalSnapshots.js'
import { ChatError } from './chatEngine.js'

const SYMBOL = /^[A-Z0-9&-]{1,30}$/
const EXPIRY = /^\d{4}-\d{2}-\d{2}$/
export const WORD_LIMIT_RANGE = [20, 1000]
const TIME = /^\d{2}:\d{2}$/
const DIFF_METRICS = new Set(['OI', 'LTP', 'IV', 'Delta', 'Gamma'])
const DIFF_STRIKES_EACH_SIDE = 5

// The 26 snapshot times of a trading day: 09:15, 09:30 ... 15:30 IST.
export const SNAPSHOT_TIMES = Array.from({ length: 26 }, (_, i) => {
  const minutes = 9 * 60 + 15 + i * 15
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
})
// "Compare with" choices: how far before the chosen time the earlier snapshot is looked up.
export const COMPARE_SECONDS = { '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 }
export const COMPARE_LABELS = { '15m': '15 minutes', '1h': '1 hour', '4h': '4 hours', '1d': '1 day' }

/** Epoch seconds of an IST date (YYYY-MM-DD) and time (HH:MM). */
export const istEpoch = (date, time) => Date.parse(`${date}T${time}:00+05:30`) / 1000
const isRealDate = (date) => EXPIRY.test(date) && !Number.isNaN(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date

/** { optionChain, wordLimit } from a request body -> { value } (only the fields that were sent) or { error }. */
export function validateChatContext({ optionChain, wordLimit } = {}, now = new Date()) {
  const value = {}
  if (optionChain != null) {
    const symbol = typeof optionChain.symbol === 'string' ? optionChain.symbol.trim().toUpperCase() : ''
    if (!SYMBOL.test(symbol)) return { error: 'Pick a valid option chain symbol' }
    const chosen = { symbol }
    if (optionChain.asOf != null) {
      const date = typeof optionChain.asOf.date === 'string' ? optionChain.asOf.date.trim() : ''
      const time = typeof optionChain.asOf.time === 'string' ? optionChain.asOf.time.trim() : ''
      if (!isRealDate(date)) return { error: 'Pick a valid snapshot date (YYYY-MM-DD)' }
      if (!TIME.test(time) || !SNAPSHOT_TIMES.includes(time)) return { error: `Pick a snapshot time between ${SNAPSHOT_TIMES[0]} and ${SNAPSHOT_TIMES.at(-1)} in 15-minute steps` }
      const weekday = new Date(`${date}T00:00:00Z`).getUTCDay()
      if (weekday === 0 || weekday === 6) return { error: 'Snapshots are only saved on weekdays' }
      if (istEpoch(date, time) > now.getTime() / 1000) return { error: 'That snapshot time is in the future' }
      chosen.asOf = { date, time }
    } else {
      const expiryDate = typeof optionChain.expiryDate === 'string' ? optionChain.expiryDate.trim() : ''
      if (!isRealDate(expiryDate)) return { error: 'Pick a valid expiry date (YYYY-MM-DD)' }
      chosen.expiryDate = expiryDate
    }
    if (optionChain.compareWith != null) {
      if (!Object.hasOwn(COMPARE_SECONDS, optionChain.compareWith)) return { error: `Compare with one of: ${Object.keys(COMPARE_SECONDS).join(', ')}` }
      chosen.compareWith = optionChain.compareWith
    }
    value.optionChain = chosen
  }
  if (wordLimit != null) {
    if (!Number.isInteger(wordLimit) || wordLimit < WORD_LIMIT_RANGE[0] || wordLimit > WORD_LIMIT_RANGE[1]) return { error: `Word limit must be a whole number from ${WORD_LIMIT_RANGE[0]} to ${WORD_LIMIT_RANGE[1]}` }
    value.wordLimit = wordLimit
  }
  return { value }
}

/** The metric changes between a stored snapshot and the live chain, near the money, unchanged values left out. */
export function changeSinceSnapshot(previous, current) {
  const spot = current.underlyingLtp
  const near = new Set(current.strikes.map((s) => s.strike).sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot)).slice(0, DIFF_STRIKES_EACH_SIDE * 2 + 1))
  return buildOptionChainDiff(previous, current)
    .filter((r) => near.has(r.strike) && DIFF_METRICS.has(r.metric) && r.diff != null && r.diff !== 0)
    .map(({ strike, side, metric, prev, curr, diff, pct }) => ({ strike, side, metric, prev, curr, diff, pct }))
}

const istLabel = (tick) => `${new Date((tick + 19800) * 1000).toISOString().slice(0, 16).replace('T', ' ')} IST`

/** The text block the model sees. `savedAt` ("2026-11-27 10:15 IST") marks a saved snapshot, otherwise the chain is live. */
export function formatOptionChainBlock({ symbol, expiryDate, spot, strikes, fetchedAt, savedAt, previous, changes, compareLabel }) {
  const columns = `ATM +/- ${DEFAULT_VIEW_STRIKES_EACH_SIDE} strikes; ce = call, pe = put; oi = open interest, iv = implied volatility.`
  const lines = [
    savedAt
      ? `OPTION CHAIN DATA (saved 15-minute snapshot of ${savedAt}, not live) - ${symbol}, expiry ${expiryDate}. Underlying price at that time ${spot}. ${columns} Volume is not stored in saved snapshots.`
      : `OPTION CHAIN DATA (Groww) - ${symbol}, expiry ${expiryDate}, fetched ${fetchedAt} (UTC). Underlying last price ${spot}. ${columns} When the market is closed these are the last available values.`,
    JSON.stringify(strikes),
  ]
  if (changes) {
    lines.push(
      `CHANGE SINCE THE STORED SNAPSHOT of ${istLabel(previous.tick)} (underlying was ${previous.underlyingLtp})${compareLabel ? `, the snapshot about ${compareLabel} earlier` : ''}, near the money, only values that changed:`,
      JSON.stringify(changes)
    )
  } else {
    lines.push(`No earlier snapshot of this symbol and expiry${compareLabel ? ` about ${compareLabel} before` : ''} is stored, so only this single point in time is available: say so if a question needs OI additions, unwinding or other changes.`)
  }
  return lines.join('\n')
}

const defaultDeps = {
  getToken: async () => (await import('../firestoreClient.js')).getStoredGrowwAccessToken(),
  fetchChain: fetchFilteredOptionChain,
  loadSnapshot: async (symbol, tickLimit, maxAgeSeconds) => {
    const admin = (await import('firebase-admin')).default
    const { getFirestore } = await import('firebase-admin/firestore')
    return readSnapshotAtOrBefore(getFirestore(admin.app(), 'groww-dashboard'), symbol, tickLimit, maxAgeSeconds)
  },
}

// How much older than the wanted tick an earlier snapshot may be: a missed tick or two intraday, a weekend or holiday for 1 day.
const slackFor = (lookback) => (lookback >= 86400 ? 4 * 86400 : 2 * 900)

/**
 * deps: getToken(), fetchChain({...}), loadSnapshot(symbol, tickLimit, maxAgeSeconds) -> the newest stored snapshot at or
 * before tickLimit, no older than maxAgeSeconds, or null. Returns the text block.
 */
export async function buildOptionChainContext({ symbol, expiryDate, asOf, compareWith }, deps = {}, now = new Date()) {
  const { getToken, fetchChain, loadSnapshot } = { ...defaultDeps, ...deps }
  const nowSeconds = Math.floor(now.getTime() / 1000)
  const earlier = async (tickLimit, maxAge) => {
    try {
      return await loadSnapshot(symbol, tickLimit, maxAge)
    } catch (err) {
      console.error('Option chain snapshot lookup failed (continuing without it):', err.message)
      return null
    }
  }

  let current
  let expiry
  let previous
  let savedAt = null
  let lookback = compareWith ? COMPARE_SECONDS[compareWith] : null
  if (asOf) {
    // A saved snapshot needs no Groww token.
    const tick = tickOf(istEpoch(asOf.date, asOf.time))
    let snapshot
    try {
      snapshot = await loadSnapshot(symbol, tick, 0)
    } catch (err) {
      throw new ChatError(502, `Could not read the saved option chain for ${symbol}: ${err.message}`)
    }
    if (!snapshot || snapshot.tick !== tick) throw new ChatError(400, `No saved option chain snapshot for ${symbol} at ${asOf.date} ${asOf.time} IST - pick another date or time, or use live data`)
    lookback ??= COMPARE_SECONDS['15m']
    expiry = snapshot.expiry
    savedAt = `${asOf.date} ${asOf.time} IST`
    current = { strikes: limitRowsToAtm(snapshot.strikes ?? [], snapshot.underlyingLtp, DEFAULT_VIEW_STRIKES_EACH_SIDE).rows, underlyingLtp: snapshot.underlyingLtp }
    previous = await earlier(tick - lookback, slackFor(lookback))
  } else {
    const token = await getToken().catch(() => null)
    if (!token) throw new ChatError(401, 'No Groww access token is saved - paste one in the Greek Analysis tab to use Option Chain questions')
    let chain
    try {
      chain = await fetchChain({ exchange: 'NSE', underlying_symbol: symbol, expiry_date: expiryDate, points_range: 1e9, groww_token: token })
    } catch (err) {
      const status = err.details?.status_code
      if (status === 401 || status === 403) throw new ChatError(401, 'The saved Groww access token has expired - paste a new one in the Greek Analysis tab')
      if (status === 400 || status === 404) throw new ChatError(400, `Groww has no option chain for ${symbol} with expiry ${expiryDate}`)
      throw new ChatError(502, `Could not fetch the option chain for ${symbol}: ${err.details?.message ?? err.message}`)
    }
    expiry = expiryDate
    current = { strikes: compactChain(chain.filtered_strikes, chain.underlying_ltp, DEFAULT_VIEW_STRIKES_EACH_SIDE), underlyingLtp: chain.underlying_ltp }
    previous = lookback ? await earlier(tickOf(nowSeconds) - lookback, slackFor(lookback)) : await earlier(tickOf(nowSeconds), 4 * 3600)
  }

  const sameExpiry = previous && previous.expiry === expiry
  return formatOptionChainBlock({
    symbol,
    expiryDate: expiry,
    spot: current.underlyingLtp,
    strikes: current.strikes,
    fetchedAt: now.toISOString(),
    savedAt,
    previous: sameExpiry ? previous : null,
    changes: sameExpiry ? changeSinceSnapshot(previous, current) : null,
    compareLabel: compareWith ? COMPARE_LABELS[compareWith] : lookback ? COMPARE_LABELS['15m'] : null,
  })
}
