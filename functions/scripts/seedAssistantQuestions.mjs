/**
 * Seeds the assistant's standard question bank (data/assistantQuestions.json) into Firestore
 * (assistantQuestionBank/q01..q44). Idempotent: re-running overwrites the same docs.
 *
 * Needs Application Default Credentials (`gcloud auth application-default login`).
 * Usage: node functions/scripts/seedAssistantQuestions.mjs [--dry-run]
 */

import { BUNDLED_QUESTIONS, groupQuestionBank, questionId } from '../assistant/questionBank.js'

const dryRun = process.argv.includes('--dry-run')
const topics = groupQuestionBank(BUNDLED_QUESTIONS)
const count = topics.reduce((n, t) => n + t.reports.reduce((m, r) => m + r.questions.length, 0), 0)
if (count !== BUNDLED_QUESTIONS.length) {
  console.error(`${BUNDLED_QUESTIONS.length - count} row(s) in assistantQuestions.json are malformed - nothing written.`)
  process.exit(1)
}
for (const t of topics) console.log(`${t.topic}: ${t.reports.length} report(s), ${t.reports.reduce((m, r) => m + r.questions.length, 0)} question(s)`)
console.log(`${count} questions (${questionId(1)}..${questionId(count)}) -> assistantQuestionBank`)

if (dryRun) {
  console.log('Dry run: nothing written.')
  process.exit(0)
}
const { seedQuestionBank } = await import('../assistantQuestionBankFirestoreClient.js')
console.log(`Wrote ${await seedQuestionBank(BUNDLED_QUESTIONS)} docs.`)
process.exit(0)
