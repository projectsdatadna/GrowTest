/**
 * Question bank API (the Assistant's "+" picker).
 *   GET /question-bank   -> { status, topics: [{ topic, reports: [{ report, questions: [...] }] }] }
 * Reads Firestore; when that is empty (not seeded yet) or unreachable it serves the bundled copy, so the
 * picker always has data.
 */

import { BUNDLED_QUESTIONS, groupQuestionBank } from './assistant/questionBank.js'

const defaultStore = { listQuestionBank: async () => (await import('./assistantQuestionBankFirestoreClient.js')).listQuestionBank() }

export function registerQuestionBankRoutes(app, { store = defaultStore } = {}) {
  app.get('/question-bank', async (_req, res) => {
    let rows = []
    try {
      rows = await store.listQuestionBank()
    } catch (err) {
      console.error('Error reading the question bank, using the bundled copy:', err.message)
    }
    res.json({ status: 'SUCCESS', topics: groupQuestionBank(rows?.length ? rows : BUNDLED_QUESTIONS) })
  })
}
