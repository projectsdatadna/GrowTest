/**
 * Chat history: chatThreads/{id} (title, scope, counts) and
 * chatThreads/{id}/messages/{id} (role, content, citations, sources, toolCalls, usage).
 * Kept until a thread is deleted. ownerId is reserved for when sign-in is added.
 */

import admin from 'firebase-admin'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'

if (admin.apps.length === 0) admin.initializeApp({ projectId: 'dev-cogniglob' })
const db = getFirestore(admin.app(), 'groww-dashboard')
const THREADS = 'chatThreads'

const iso = (v) => v?.toDate?.().toISOString() ?? v ?? null

export async function createThread({ title, scope = null, mode = 'rag' }) {
  const ref = db.collection(THREADS).doc()
  await ref.set({ title, scope, mode, ownerId: null, messageCount: 0, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() })
  return ref.id
}

export async function getThread(id) {
  const snapshot = await db.collection(THREADS).doc(id).get()
  if (!snapshot.exists) return null
  const d = snapshot.data()
  return { id, ...d, createdAt: iso(d.createdAt), updatedAt: iso(d.updatedAt) }
}

export async function appendMessage(threadId, message) {
  const threadRef = db.collection(THREADS).doc(threadId)
  const ref = threadRef.collection('messages').doc()
  await ref.set({ ...message, createdAt: FieldValue.serverTimestamp() })
  await threadRef.update({ messageCount: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() })
  return ref.id
}

export async function listMessages(threadId, { limit = 200 } = {}) {
  const snapshot = await db.collection(THREADS).doc(threadId).collection('messages').orderBy('createdAt', 'asc').limit(limit).get()
  return snapshot.docs.map((d) => ({ id: d.id, ...d.data(), createdAt: iso(d.data().createdAt) }))
}

export async function listThreads({ limit = 50 } = {}) {
  const snapshot = await db.collection(THREADS).orderBy('updatedAt', 'desc').limit(limit).get()
  return snapshot.docs.map((d) => ({ id: d.id, ...d.data(), createdAt: iso(d.data().createdAt), updatedAt: iso(d.data().updatedAt) }))
}

export async function deleteThread(id) {
  const ref = db.collection(THREADS).doc(id)
  for (;;) {
    const snapshot = await ref.collection('messages').limit(400).get()
    if (snapshot.empty) break
    const batch = db.batch()
    snapshot.docs.forEach((d) => batch.delete(d.ref))
    await batch.commit()
  }
  await ref.delete()
}
