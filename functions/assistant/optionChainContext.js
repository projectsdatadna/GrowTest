/**
 * Option-chain context for a chat turn: when the user picked an Option Chain question with a symbol and an
 * expiry date, the live Groww chain (ATM +/- 10 strikes: LTP, OI, IV, Delta, Gamma, ...) is fetched and sent
 * to the model as a labelled data block. When the symbol has a stored 15-minute snapshot (scanner symbols),
 * the change since that snapshot is included too - the "OI added or unwound" questions need it.
 */

import { fetchFilteredOptionChain } from '../growwOptionChain.js'
import { compactChain, buildOptionChainDiff, readSnapshotAtOrBefore, tickOf, DEFAULT_VIEW_STRIKES_EACH_SIDE } from '../optionChainIntervalSnapshots.js'
import { ChatError } from './chatEngine.js'

const SYMBOL = /^[A-Z0-9&-]{1,30}$/
const EXPIRY = /^\d{4}-\d{2}-\d{2}$/
export const WORD_LIMIT_RANGE = [20, 1000]
const DIFF_METRICS = new Set(['OI', 'LTP', 'IV', 'Delta', 'Gamma'])
const DIFF_STRIKES_EACH_SIDE = 5

/** { optionChain, wordLimit } from a request body -> { value } (only the fields that were sent) or { error }. */
export function validateChatContext({ optionChain, wordLimit } = {}) {
  const value = {}
  if (optionChain != null) {
    const symbol = typeof optionChain.symbol === 'string' ? optionChain.symbol.trim().toUpperCase() : ''
    const expiryDate = typeof optionChain.expiryDate === 'string' ? optionChain.expiryDate.trim() : ''
    if (!SYMBOL.test(symbol)) return { error: 'Pick a valid option chain symbol' }
    if (!EXPIRY.test(expiryDate) || Number.isNaN(Date.parse(`${expiryDate}T00:00:00Z`))) return { error: 'Pick a valid expiry date (YYYY-MM-DD)' }
    value.optionChain = { symbol, expiryDate }
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

/** The text block the model sees. */
export function formatOptionChainBlock({ symbol, expiryDate, spot, strikes, fetchedAt, previous, changes }) {
  const lines = [
    `OPTION CHAIN DATA (Groww) - ${symbol}, expiry ${expiryDate}, fetched ${fetchedAt}. Underlying last price ${spot}. ATM +/- ${DEFAULT_VIEW_STRIKES_EACH_SIDE} strikes; ce = call, pe = put; oi = open interest, iv = implied volatility. When the market is closed these are the last available values.`,
    JSON.stringify(strikes),
  ]
  if (changes) {
    lines.push(
      `CHANGE SINCE THE STORED SNAPSHOT of ${new Date(previous.tick * 1000).toISOString()} (underlying was ${previous.underlyingLtp}), near the money, only values that changed:`,
      JSON.stringify(changes)
    )
  } else {
    lines.push('No earlier snapshot of this symbol and expiry is stored, so only this single point in time is available: say so if a question needs OI additions, unwinding or other changes.')
  }
  return lines.join('\n')
}

const defaultDeps = {
  getToken: async () => (await import('../firestoreClient.js')).getStoredGrowwAccessToken(),
  fetchChain: fetchFilteredOptionChain,
  loadSnapshot: async (symbol, nowSeconds) => {
    const admin = (await import('firebase-admin')).default
    const { getFirestore } = await import('firebase-admin/firestore')
    return readSnapshotAtOrBefore(getFirestore(admin.app(), 'groww-dashboard'), symbol, tickOf(nowSeconds), 4 * 3600)
  },
}

/** deps: getToken(), fetchChain({...}), loadSnapshot(symbol, nowSeconds) -> the stored snapshot or null. Returns the text block. */
export async function buildOptionChainContext({ symbol, expiryDate }, deps = {}, now = new Date()) {
  const { getToken, fetchChain, loadSnapshot } = { ...defaultDeps, ...deps }
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

  const strikes = compactChain(chain.filtered_strikes, chain.underlying_ltp, DEFAULT_VIEW_STRIKES_EACH_SIDE)
  const current = { strikes, underlyingLtp: chain.underlying_ltp }
  let previous = null
  try {
    previous = await loadSnapshot(symbol, Math.floor(now.getTime() / 1000))
  } catch (err) {
    console.error('Option chain snapshot lookup failed (continuing without it):', err.message)
  }
  const sameExpiry = previous && previous.expiry === expiryDate
  return formatOptionChainBlock({ symbol, expiryDate, spot: chain.underlying_ltp, strikes, fetchedAt: now.toISOString(), previous: sameExpiry ? previous : null, changes: sameExpiry ? changeSinceSnapshot(previous, current) : null })
}
