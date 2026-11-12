/**
 * Loads the NRML margins from Sheet1 of the notification-list workbook
 * (column A = SYMBOL, column B = NRML Margin) onto the scanner symbols. The
 * values are then shown on the Notifications cards and in the export, and can be
 * edited on the Crossover Scanner page.
 *
 *   node functions/scripts/importNrmlMargin.mjs ["Notification List (8).xlsx"] [--overwrite] [--dry-run]
 *
 * Blank cells never clear a value. A symbol that already has a margin (e.g. one
 * edited on the Scanner page) is left alone unless --overwrite is given.
 * Needs Application Default Credentials (gcloud auth application-default login).
 */

import { resolve } from 'path'
import { readMarginSheet } from '../marginSheet.js'
import { listActiveScannerSymbols, resolveListSymbol, scannerSymbolId, setScannerSymbolMargin } from '../crossoverScannerFirestoreClient.js'

const args = process.argv.slice(2)
const OVERWRITE = args.includes('--overwrite')
const DRY_RUN = args.includes('--dry-run')
const file = resolve(args.find((a) => !a.startsWith('--')) || 'Notification List (8).xlsx')

async function main() {
  const rows = await readMarginSheet(file)
  console.log(`Read ${rows.length} symbols from ${file} (Sheet1): ${rows.filter((r) => r.margin != null).length} with an NRML margin.`)

  const active = await listActiveScannerSymbols()
  const names = new Set(active.map((s) => s.symbol))
  const byName = new Map(active.map((s) => [s.symbol, s]))

  const written = []
  const keptExisting = []
  const blank = []
  const unmatched = []
  for (const { symbol, margin } of rows) {
    const resolved = resolveListSymbol(symbol, names)
    if (!resolved) {
      unmatched.push(symbol)
      continue
    }
    if (margin == null) {
      blank.push(symbol)
      continue
    }
    const entry = byName.get(resolved)
    if (entry.nrmlMargin != null && !OVERWRITE) {
      keptExisting.push(symbol)
      continue
    }
    if (!DRY_RUN) await setScannerSymbolMargin(scannerSymbolId(entry.exchange, entry.symbol), margin)
    written.push(symbol)
  }

  console.log(`${DRY_RUN ? 'Would save' : 'Saved'} ${written.length} margin(s).`)
  if (keptExisting.length) console.log(`Kept the existing value for ${keptExisting.length} symbol(s) (use --overwrite to replace): ${keptExisting.join(', ')}`)
  if (blank.length) console.log(`No margin in the sheet for ${blank.length} symbol(s): ${blank.join(', ')}`)
  if (unmatched.length) console.log(`Not active in the scanner (skipped): ${unmatched.join(', ')}`)
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error)
  process.exit(1)
})
