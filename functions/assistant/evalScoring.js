/**
 * Scoring for the assistant evaluation (scripts/evalAssistant.mjs). A golden question lists what a good
 * answer must show; this checks one finished answer against it. Pure.
 *
 *   { id, question, mode?, scope?,
 *     mustContain?: [text...]          every string appears (case-insensitive, commas in numbers ignored)
 *     mustNotContain?: [text...]       none appears (e.g. a figure from the wrong date)
 *     citeDates?: ['2025-11-14']       the answer cites at least one source of each of these report dates
 *     onlyDates?: ['2025-11-14']       every cited source is from these dates (the date filter held)
 *     expectRefusal?: true             the answer must say it is not in the documents / no such report }
 */

const normalise = (s) => String(s).toLowerCase().replace(/(\d),(?=\d{3})/g, '$1')
const REFUSAL = /not in the uploaded documents|could not find anything relevant|no indexed documents|no documents for|do not have|don't have/i

export function scoreAnswer(golden, { answer, citations = [], error = null }) {
  const failures = []
  if (error) return { id: golden.id, pass: false, failures: [`error: ${error}`] }
  const text = normalise(answer)
  for (const s of golden.mustContain || []) if (!text.includes(normalise(s))) failures.push(`missing "${s}"`)
  for (const s of golden.mustNotContain || []) if (text.includes(normalise(s))) failures.push(`should not contain "${s}"`)
  const cited = new Set(citations.map((c) => c.reportDate))
  for (const d of golden.citeDates || []) if (!cited.has(d)) failures.push(`no citation from ${d}`)
  if (golden.onlyDates?.length) for (const c of citations) if (!golden.onlyDates.includes(c.reportDate)) failures.push(`cites a source dated ${c.reportDate}`)
  if (golden.expectRefusal && !REFUSAL.test(answer)) failures.push('should have said the information is not available')
  if (!golden.expectRefusal && !citations.length) failures.push('no citations')
  return { id: golden.id, pass: failures.length === 0, failures }
}

export function summarize(results) {
  const passed = results.filter((r) => r.pass).length
  return { total: results.length, passed, failed: results.length - passed, rate: results.length ? Math.round((passed / results.length) * 100) : 0 }
}
