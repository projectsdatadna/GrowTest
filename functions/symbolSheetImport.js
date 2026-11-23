/**
 * Loads the symbol sheet (SYMBOL | Margin | Price | Lot Size) onto the scanner
 * symbols: nrmlMargin, lotSize and sheetPrice. The Notifications cards use lotSize
 * and (as a fallback when no live quote is available) sheetPrice for the suggested
 * Stoploss / Target. planSymbolSheetImport is pure so it is tested offline.
 */

import {
  listActiveScannerSymbols,
  resolveListSymbol,
  scannerSymbolId,
  setScannerSymbolSheetData,
} from './crossoverScannerFirestoreClient.js'

/**
 * Which scanner symbols change. `active` = listActiveScannerSymbols() entries.
 *  - nrmlMargin: only written when the sheet has one, and (unless `overwrite`) the
 *    symbol has none yet - a margin edited on the Scanner page is not clobbered.
 *  - lotSize / sheetPrice: the sheet is the source of truth, always refreshed.
 * Blank sheet cells never clear anything.
 */
export function planSymbolSheetImport(rows, active, { overwrite = false } = {}) {
  const names = new Set(active.map((s) => s.symbol))
  const byName = new Map(active.map((s) => [s.symbol, s]))
  const updates = []
  const unmatched = []
  const keptMargin = []
  for (const row of rows) {
    const resolved = resolveListSymbol(row.symbol, names)
    if (!resolved) {
      unmatched.push(row.symbol)
      continue
    }
    const entry = byName.get(resolved)
    const fields = {}
    if (row.margin != null) {
      if (entry.nrmlMargin == null || overwrite) fields.nrmlMargin = row.margin
      else if (entry.nrmlMargin !== row.margin) keptMargin.push(row.symbol)
    }
    if (row.lotSize != null) fields.lotSize = row.lotSize
    if (row.price != null) fields.sheetPrice = row.price
    const changed = Object.entries(fields).some(([key, value]) => entry[key] !== value)
    updates.push({ id: scannerSymbolId(entry.exchange, entry.symbol), symbol: entry.symbol, fields, changed })
  }
  return { updates: updates.filter((u) => Object.keys(u.fields).length > 0), unmatched, keptMargin }
}

/** Plans and (unless dryRun) saves. Returns counts the UI shows before / after confirming. */
export async function importSymbolSheet(rows, { overwrite = false, dryRun = false } = {}) {
  const active = await listActiveScannerSymbols()
  const plan = planSymbolSheetImport(rows, active, { overwrite })
  const changed = plan.updates.filter((u) => u.changed)
  if (!dryRun) {
    const now = new Date().toISOString()
    for (const update of changed) await setScannerSymbolSheetData(update.id, { ...update.fields, sheetUpdatedAt: now })
  }
  return {
    dryRun,
    rowsInSheet: rows.length,
    matched: plan.updates.length,
    changed: changed.length,
    updated: dryRun ? 0 : changed.length,
    unmatched: plan.unmatched,
    keptExistingMargin: plan.keptMargin,
  }
}
