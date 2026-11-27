/**
 * assistantQuestionBank/{q01..q44}: one doc per standard question (no, topic, report, question, movement,
 * signal?). Read by GET /question-bank; written only by scripts/seedAssistantQuestions.mjs.
 */

import admin from 'firebase-admin'
import { getFirestore } from 'firebase-admin/firestore'
import { questionId } from './assistant/questionBank.js'

if (admin.apps.length === 0) admin.initializeApp({ projectId: 'dev-cogniglob' })
const db = getFirestore(admin.app(), 'groww-dashboard')
const COLLECTION = 'assistantQuestionBank'

export async function listQuestionBank() {
  const snapshot = await db.collection(COLLECTION).get()
  return snapshot.docs.map((doc) => doc.data())
}

/** Idempotent: the doc id comes from the row number, so re-running overwrites rather than duplicates. */
export async function seedQuestionBank(rows) {
  const batch = db.batch()
  for (const row of rows) batch.set(db.collection(COLLECTION).doc(questionId(row.no)), row)
  await batch.commit()
  return rows.length
}
