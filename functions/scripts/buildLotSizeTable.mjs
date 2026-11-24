/**
 * Builds functions/data/lotSizes.json - the lot sizes built into the app - from sheet 2 of the
 * "Stp & Target Sample" workbook (SYMBOL | Margin | Price | Lot Size). Run it again after a newer sheet:
 *
 *   node functions/scripts/buildLotSizeTable.mjs ["Stp & Target Sample (1).xlsx"] [--dry-run]
 *
 * The sheet truncates names that contain symbols (M for M&M, BAJAJ for BAJAJ-AUTO ...), so every row is
 * resolved to the scanner's own symbol name first (the same rule the sheet import uses); the table is keyed by
 * that name. Rows that match no scanner symbol (#N/A, NIFTYFPI) are dropped. Active scanner STOCKS the sheet does
 * not list get their futures lot size from the Groww instrument file (instruments.csv) and are marked "verify".
 * Needs Application Default Credentials (it reads the active scanner symbols from Firestore).
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'csv-parse/sync'
import { readSymbolSheetFile } from '../marginSheet.js'
import { listActiveScannerSymbols, resolveListSymbol } from '../crossoverScannerFirestoreClient.js'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const sheetPath = resolve(args.find((a) => !a.startsWith('--')) || resolve(here, '../../Stp & Target Sample (1).xlsx'))
const instrumentsPath = resolve(here, '../../instruments.csv')
const outPath = resolve(here, '../data/lotSizes.json')

const sheet = await readSymbolSheetFile(sheetPath)
if (!sheet) throw new Error(`No sheet with SYMBOL and Lot Size columns in ${sheetPath}`)
const active = await listActiveScannerSymbols()
const names = new Set(active.map((s) => s.symbol))

const lots = {}
const dropped = []
for (const row of sheet.rows) {
  const symbol = names.has(row.symbol) ? row.symbol : resolveListSymbol(row.symbol, names)
  if (!symbol || !row.lotSize) dropped.push(row.symbol)
  else lots[symbol] = row.lotSize
}

// Stocks the sheet lacks: the nearest futures contract's lot size from the instrument file.
const futuresLot = new Map()
for (const row of parse(readFileSync(instrumentsPath, 'utf8'), { columns: true, skip_empty_lines: true })) {
  if (row.segment === 'FNO' && row.instrument_type === 'FUT' && row.lot_size && row.underlying_symbol) {
    const current = futuresLot.get(row.underlying_symbol)
    if (!current || row.expiry_date < current.expiry) futuresLot.set(row.underlying_symbol, { expiry: row.expiry_date, lot: Number(row.lot_size) })
  }
}
const verify = []
const stillMissing = []
for (const entry of active) {
  if (lots[entry.symbol]) continue
  const fromFile = !entry.isIndex && futuresLot.get(entry.symbol)
  if (fromFile) {
    lots[entry.symbol] = fromFile.lot
    verify.push(entry.symbol)
  } else stillMissing.push(entry.symbol)
}

const table = {
  source: `${sheet.sheetName} of the Stp & Target Sample workbook (symbol, lot size); symbols in "verify" are not in that sheet and come from the Groww instrument file (instruments.csv) - check them`,
  lots: Object.fromEntries(Object.entries(lots).sort(([a], [b]) => a.localeCompare(b))),
  verify: verify.sort(),
}
console.log(`sheet rows ${sheet.rows.length} -> ${Object.keys(lots).length - verify.length} lot sizes from the sheet; dropped (no scanner symbol): ${dropped.join(', ') || 'none'}`)
console.log(`from instruments.csv (verify): ${verify.map((s) => `${s} ${lots[s]}`).join(', ') || 'none'}`)
console.log(`active scanner symbols without any lot size: ${stillMissing.join(', ') || 'none'}`)
if (!DRY_RUN) {
  writeFileSync(outPath, `${JSON.stringify(table, null, 2)}\n`)
  console.log(`wrote ${outPath} (${Object.keys(table.lots).length} symbols)`)
}
process.exit(0)
