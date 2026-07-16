/**
 * One-time script: loads unique_underlying_symbols.csv and writes the list
 * into Firestore for the Underlying Symbol dropdown to read.
 *
 * Prerequisites:
 *   - Firestore enabled + a Native-mode database created on the target project.
 *   - Application Default Credentials available locally (`gcloud auth
 *     application-default login`) - same auth firebase-admin needs for any
 *     local script; Cloud Functions get this automatically in production.
 *
 * Usage: node functions/scripts/seedUnderlyingSymbols.mjs
 */

import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { setUnderlyingSymbols } from '../firestoreClient.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CSV_PATH = join(__dirname, '..', '..', 'unique_underlying_symbols.csv')

function parseSymbolsCsv(csvText) {
  return csvText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(1) // drop the "underlying_symbol" header row
}

async function main() {
  const csvText = readFileSync(CSV_PATH, 'utf-8')
  const symbols = parseSymbolsCsv(csvText)

  if (symbols.length === 0) {
    throw new Error(`No symbols parsed from ${CSV_PATH}`)
  }

  await setUnderlyingSymbols(symbols)
  console.log(`Seeded ${symbols.length} underlying symbols into Firestore.`)
}

main().catch((error) => {
  console.error('Seed failed:', error.message)
  process.exit(1)
})
