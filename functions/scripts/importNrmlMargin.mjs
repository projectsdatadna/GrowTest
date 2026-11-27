/**
 * Loads the symbol sheet onto the scanner symbols: NRML margin, lot size and
 * the sheet price. Works with either workbook: the sheet is found by its headers
 * (SYMBOL plus Margin / "NRML Margin", Price, Lot Size), e.g. Sheet2 of
 * "Stp & Target Sample.xlsx" or Sheet1 of "Notification List (8).xlsx". They are
 * shown on the Notifications cards (margin, suggested Stoploss / Target) and in
 * the export; margin can still be edited on the Crossover Scanner page.
 *
 *   node functions/scripts/importNrmlMargin.mjs ["Stp & Target Sample (1).xlsx"] [--overwrite] [--dry-run]
 *
 * Blank cells never clear a value. A symbol that already has a margin (e.g. one
 * edited on the Scanner page) keeps it unless --overwrite is given; lot size and
 * sheet price are always refreshed from the sheet.
 * Needs Application Default Credentials (gcloud auth application-default login).
 */

import { resolve } from 'path'
import { readSymbolSheetFile } from '../marginSheet.js'
import { importSymbolSheet } from '../symbolSheetImport.js'

const args = process.argv.slice(2)
const OVERWRITE = args.includes('--overwrite')
const DRY_RUN = args.includes('--dry-run')
const file = resolve(args.find((a) => !a.startsWith('--')) || 'Stp & Target Sample (1).xlsx')

async function main() {
  const parsed = await readSymbolSheetFile(file)
  if (!parsed) throw new Error(`No sheet with a SYMBOL column and a Margin / Price / Lot Size column in ${file}`)
  console.log(`Read ${parsed.rows.length} symbols from ${file} (${parsed.sheetName}): ${parsed.rows.filter((r) => r.margin != null).length} margins, ${parsed.rows.filter((r) => r.lotSize != null).length} lot sizes.`)

  const result = await importSymbolSheet(parsed.rows, { overwrite: OVERWRITE, dryRun: DRY_RUN })
  console.log(`${DRY_RUN ? 'Would update' : 'Updated'} ${DRY_RUN ? result.changed : result.updated} of ${result.matched} matched symbol(s).`)
  if (result.keptExistingMargin.length) console.log(`Kept the existing margin for ${result.keptExistingMargin.length} symbol(s) (use --overwrite to replace): ${result.keptExistingMargin.join(', ')}`)
  if (result.unmatched.length) console.log(`Not active in the scanner (skipped): ${result.unmatched.join(', ')}`)
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error)
  process.exit(1)
})
