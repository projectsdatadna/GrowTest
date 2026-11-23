/**
 * Runs golden questions against a RUNNING assistant server and scores each answer
 * (see assistant/evalScoring.js for the golden file format). Use it after uploading real
 * reports to check retrieval, date filtering, citations and refusals - and again after any
 * prompt / chunking / model change, to see what got better or worse.
 *
 *   node functions/scripts/evalAssistant.mjs golden.json [http://localhost:5055]
 *
 * Exit code 1 if any question fails. Each question is a fresh conversation. This calls the real
 * model (a few cents per question).
 */

import { readFileSync } from 'node:fs'
import { scoreAnswer, summarize } from '../assistant/evalScoring.js'
import { createSseParser } from '../../src/services/sse.js'

const [file, base = 'http://localhost:5055'] = process.argv.slice(2)
if (!file) {
  console.error('usage: node functions/scripts/evalAssistant.mjs golden.json [baseUrl]')
  process.exit(2)
}
const golden = JSON.parse(readFileSync(file, 'utf8'))

async function ask(question, mode = 'rag', scope = {}) {
  const response = await fetch(`${base}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: question, mode, scope }) })
  if (!response.ok) return { answer: '', error: `HTTP ${response.status}` }
  let answer = ''
  let citations = []
  let sources = []
  let error = null
  const parser = createSseParser((event, data) => {
    if (event === 'delta') answer += data.text
    else if (event === 'reset') answer = ''
    else if (event === 'sources') sources = data.sources
    else if (event === 'done') citations = data.citations
    else if (event === 'error') error = data.error
  })
  const decoder = new TextDecoder()
  for await (const chunk of response.body) parser.feed(decoder.decode(chunk, { stream: true }))
  parser.end()
  // citations carry docId/page; dates come from the matching source
  return { answer, error, citations: citations.map((c) => ({ ...c, reportDate: c.reportDate ?? sources.find((s) => s.n === c.n)?.reportDate ?? null })) }
}

const results = []
for (const g of golden) {
  const started = Date.now()
  const result = scoreAnswer(g, await ask(g.question, g.mode, g.scope))
  results.push(result)
  console.log(`${result.pass ? 'PASS' : 'FAIL'}  ${g.id}  (${((Date.now() - started) / 1000).toFixed(1)}s)${result.failures.length ? `\n      - ${result.failures.join('\n      - ')}` : ''}`)
}
const summary = summarize(results)
console.log(`\n${summary.passed}/${summary.total} passed (${summary.rate}%)`)
process.exit(summary.failed ? 1 : 0)
