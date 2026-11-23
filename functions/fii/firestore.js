/** Firestore side of FII analysis: fiiMetrics/{docId} (extracted figures) and fiiComparisons/{currentDoc__previousDoc} (cached AI comparisons). */

import admin from 'firebase-admin'
import { getFirestore } from 'firebase-admin/firestore'

if (admin.apps.length === 0) admin.initializeApp({ projectId: 'dev-cogniglob' })
const db = getFirestore(admin.app(), 'groww-dashboard')
const iso = (v) => v?.toDate?.().toISOString() ?? v ?? null

export async function getFiiMetrics(docId) {
  const snapshot = await db.collection('fiiMetrics').doc(docId).get()
  if (!snapshot.exists) return null
  const d = snapshot.data()
  return { ...d, extractedAt: iso(d.extractedAt) }
}

export async function saveFiiMetrics(docId, record) {
  await db.collection('fiiMetrics').doc(docId).set(record)
}

export async function getFiiComparison(id) {
  const snapshot = await db.collection('fiiComparisons').doc(id).get()
  return snapshot.exists ? snapshot.data() : null
}

export async function saveFiiComparison(id, result) {
  await db.collection('fiiComparisons').doc(id).set(result)
}
