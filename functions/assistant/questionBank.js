/**
 * The assistant's standard question bank: Topic -> Exact NSE report name -> Questions to analyse.
 * The 44 rows live in data/assistantQuestions.json (seeded into Firestore by
 * scripts/seedAssistantQuestions.mjs); the bundled copy is also the fallback when the collection is empty.
 * Pure - no Firestore here, so tests can use it directly.
 */

import { readFileSync } from 'node:fs'

export const BUNDLED_QUESTIONS = JSON.parse(readFileSync(new URL('../data/assistantQuestions.json', import.meta.url), 'utf8'))

/** Firestore doc id of a row: q01 ... q44. */
export const questionId = (no) => `q${String(no).padStart(2, '0')}`

const isRow = (r) => r && Number.isInteger(r.no) && ['topic', 'report', 'question'].every((k) => typeof r[k] === 'string' && r[k].trim())

/**
 * Rows -> [{ topic, reports: [{ report, questions: [{ id, no, text, movement, signal? }] }] }].
 * Ordered by `no`: topics and reports appear in the order of their first row. Malformed rows are skipped.
 */
export function groupQuestionBank(rows) {
  const topics = new Map()
  for (const row of [...(rows || [])].filter(isRow).sort((a, b) => a.no - b.no)) {
    if (!topics.has(row.topic)) topics.set(row.topic, new Map())
    const reports = topics.get(row.topic)
    if (!reports.has(row.report)) reports.set(row.report, [])
    const question = { id: questionId(row.no), no: row.no, text: row.question, movement: row.movement ?? '' }
    if (row.signal) question.signal = row.signal
    reports.get(row.report).push(question)
  }
  return [...topics].map(([topic, reports]) => ({ topic, reports: [...reports].map(([report, questions]) => ({ report, questions })) }))
}
