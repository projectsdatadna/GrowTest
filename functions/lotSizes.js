/**
 * Lot sizes for the Suggested Stoploss / Target. Where a card's lot size comes from, first match wins:
 *   1. lotSizeOverride  a value the user typed on the card (Firestore, shared, never touched by the sheet import)
 *   2. lotSize          the uploaded lot size sheet (Firestore)
 *   3. the built-in table data/lotSizes.json - sheet 2 of the Stp & Target workbook, keyed by scanner symbol
 *      (rebuilt with scripts/buildLotSizeTable.mjs); a few symbols the sheet lacks come from the Groww
 *      instrument file and are flagged "verify"
 * Pure apart from reading the table once.
 */

import { readFileSync } from 'node:fs'

const table = JSON.parse(readFileSync(new URL('./data/lotSizes.json', import.meta.url), 'utf8'))
const verifySet = new Set(table.verify || [])

export const BUILT_IN_LOT_COUNT = Object.keys(table.lots).length

const positiveInt = (value) => Number.isInteger(value) && value > 0

/** { lotSize, verify } of the built-in table for a scanner symbol, or null. */
export function builtInLot(symbol) {
  const lotSize = table.lots[symbol]
  return positiveInt(lotSize) ? { lotSize, verify: verifySet.has(symbol) } : null
}

/**
 * entry: a scanner symbol record ({ symbol, lotSizeOverride?, lotSize? }) ->
 * { lotSize: number | null, lotSizeSource: 'user' | 'sheet' | 'builtin' | 'verify' | null }
 */
export function resolveLotSize(entry) {
  if (positiveInt(entry?.lotSizeOverride)) return { lotSize: entry.lotSizeOverride, lotSizeSource: 'user' }
  if (positiveInt(entry?.lotSize)) return { lotSize: entry.lotSize, lotSizeSource: 'sheet' }
  const builtIn = builtInLot(entry?.symbol)
  if (builtIn) return { lotSize: builtIn.lotSize, lotSizeSource: builtIn.verify ? 'verify' : 'builtin' }
  return { lotSize: null, lotSizeSource: null }
}

// The lot-size route and the card editor share one rule: a whole number > 0 sets it, empty resets it.
export { parseLotSize as validateLotSizeInput } from './stopTargetCalc.js'
