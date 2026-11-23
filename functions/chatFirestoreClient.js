/**
 * Chat conversations: conversations/{id} (title, fileIds = the files attached to the conversation) and
 * conversations/{id}/messages/{id} (role, content, fileIds attached on that turn, usage). Kept until
 * deleted. ownerId is reserved for when sign-in is added.
 */

import admin from 'firebase-admin'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'

if (admin.apps.length === 0) admin.initializeApp({ projectId: 'dev-cogniglob' })
const db = getFirestore(admin.app(), 'groww-dashboard')
const CONVERSATIONS = 'conversations'
const iso = (v) => v?.toDate?.().toISOString() ?? v ?? null

export async function createConversation({ title }) {
  const ref = db.collection(CONVERSATIONS).doc()
  await ref.set({ title, fileIds: [], ownerId: null, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() })
  return { id: ref.id, title, fileIds: [] }
}

export async function getConversation(id) {
  const snapshot = await db.collection(CONVERSATIONS).doc(id).get()
  if (!snapshot.exists) return null
  const d = snapshot.data()
  return { id, ...d, fileIds: d.fileIds || [], createdAt: iso(d.createdAt), updatedAt: iso(d.updatedAt) }
}

export async function setConversationFiles(id, fileIds) {
  await db.collection(CONVERSATIONS).doc(id).update({ fileIds, updatedAt: FieldValue.serverTimestamp() })
}

/** Writes messages in order (explicit millisecond offsets keep the order stable). */
export async function appendMessages(id, messages) {
  const ref = db.collection(CONVERSATIONS).doc(id)
  const base = Date.now()
  const batch = db.batch()
  messages.forEach((m, i) => batch.set(ref.collection('messages').doc(), { ...m, createdAt: new Date(base + i) }))
  batch.update(ref, { updatedAt: FieldValue.serverTimestamp() })
  await batch.commit()
}

export async function listMessages(id, { limit = 200 } = {}) {
  const snapshot = await db.collection(CONVERSATIONS).doc(id).collection('messages').orderBy('createdAt', 'asc').limit(limit).get()
  return snapshot.docs.map((d) => ({ id: d.id, ...d.data(), createdAt: iso(d.data().createdAt) }))
}
