/**
 * Makes Sheet1 (column A) of the notification-list workbook the scanner's
 * display order: indices first, then this order, on the Notifications page,
 * the Overview, the scanner's stock table and the Excel export.
 *
 *   node functions/scripts/importSymbolOrder.mjs ["Notification List (2).xlsx"] [--add]
 *
 * --add  also adds listed symbols that are not in the scanner yet (validated
 *        against the instrument master; rejected ones are reported).
 * Needs Application Default Credentials (gcloud auth application-default login).
 */

import ExcelJS from 'exceljs'
import { resolve } from 'path'
import { searchInstruments } from '../instrumentMasterSync.js'
import { addScannerSymbol, listActiveScannerSymbols, setSymbolOrder, resolveListSymbol } from '../crossoverScannerFirestoreClient.js'

const args = process.argv.slice(2)
const ADD = args.includes('--add')
const file = resolve(args.find((a) => !a.startsWith('--')) || 'Notification List (2).xlsx')

export async function readSheet1Symbols(path) {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(path)
  const sheet = workbook.worksheets[0]
  const symbols = []
  sheet.getColumn(1).eachCell((cell) => {
    const value = String(cell.text ?? cell.value ?? '').trim().toUpperCase()
    if (value && value !== 'SYMBOL' && !symbols.includes(value)) symbols.push(value)
  })
  return symbols
}

async function main() {
  const symbols = await readSheet1Symbols(file)
  console.log(`Read ${symbols.length} unique symbols from ${file} (Sheet1, column A).`)

  const active = new Set((await listActiveScannerSymbols()).map((s) => s.symbol))
  const missing = symbols.filter((s) => !resolveListSymbol(s, active))
  const rejected = []
  if (missing.length) {
    console.log(`${missing.length} listed symbol(s) are not active in the scanner: ${missing.join(', ')}`)
    if (ADD) {
      for (const symbol of missing) {
        const match = (await searchInstruments(symbol, 20)).find((m) => m.symbol === symbol && m.exchange === 'NSE')
        if (!match) {
          rejected.push(symbol)
          continue
        }
        await addScannerSymbol({ symbol, exchange: 'NSE', source: 'sheet-import', instrumentType: match.instrumentType })
      }
      console.log(`Added ${missing.length - rejected.length}; not found in the instrument master: ${rejected.join(', ') || 'none'}`)
    } else {
      console.log('Re-run with --add to add them.')
    }
  }

  const result = await setSymbolOrder(symbols)
  console.log(`Order saved for ${result.ordered} symbols; ${result.groupsUpdated} recent crossover group(s) re-sorted.`)
  if (result.unresolved.length) console.log(`Listed but not matched to any scanner symbol (skipped): ${result.unresolved.join(', ')}`)
  if (result.unlisted.length) console.log(`Scanner symbols not in the list (sorted last): ${result.unlisted.join(', ')}`)
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().then(() => process.exit(0)).catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
