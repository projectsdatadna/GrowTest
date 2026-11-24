/**
 * Uploaded files (PDF / Excel / CSV), stored in Firestore.
 *
 *   files/{fileId}               metadata: title, fileName, mimeType, kind ('pdf'|'sheet'), reportDate,
 *                                sizeBytes, sha256, partCount, uploadedAt, deleted
 *   files/{fileId}/parts/{00000} { data: Bytes } - the file's bytes in ~800 KB parts, because a Firestore
 *                                document is limited to 1 MiB
 *
 * Files are kept until someone deletes them; delete is a soft flag (the bytes stay). The metadata
 * document is written LAST, so a half-written upload never shows up in the library.
 */

import admin from 'firebase-admin'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'

if (admin.apps.length === 0) admin.initializeApp({ projectId: 'dev-cogniglob' })
const db = getFirestore(admin.app(), 'groww-dashboard')

export const FILES_COLLECTION = 'files'
export const PART_BYTES = 800 * 1024
const PARTS_PER_BATCH = 5 // ~4 MB per commit, well under Firestore's 10 MiB request limit

const iso = (value) => value?.toDate?.().toISOString() ?? value ?? null
const serialize = (doc) => {
  const data = doc.data()
  return { id: doc.id, ...data, uploadedAt: iso(data.uploadedAt), deletedAt: iso(data.deletedAt) }
}

/** Buffer -> Buffer[] of at most `size` bytes (a zero-length buffer gives no parts). */
export function splitIntoParts(buffer, size = PART_BYTES) {
  const parts = []
  for (let i = 0; i < buffer.length; i += size) parts.push(buffer.subarray(i, i + size))
  return parts
}
export const joinParts = (parts) => Buffer.concat(parts)

/** Stores the bytes, then the metadata. Returns the new file's metadata (with id). */
export async function createFile(meta, buffer) {
  const ref = db.collection(FILES_COLLECTION).doc()
  const parts = splitIntoParts(buffer)
  for (let i = 0; i < parts.length; i += PARTS_PER_BATCH) {
    const batch = db.batch()
    parts.slice(i, i + PARTS_PER_BATCH).forEach((data, j) => batch.set(ref.collection('parts').doc(String(i + j).padStart(5, '0')), { data }))
    await batch.commit()
  }
  await ref.set({ ...meta, partCount: parts.length, deleted: false, uploadedAt: FieldValue.serverTimestamp() })
  return serialize(await ref.get())
}

export async function getFile(id) {
  const snapshot = await db.collection(FILES_COLLECTION).doc(id).get()
  return snapshot.exists ? serialize(snapshot) : null
}

export async function getFiles(ids) {
  if (!ids.length) return []
  const snapshots = await db.getAll(...ids.map((id) => db.collection(FILES_COLLECTION).doc(id)))
  return snapshots.filter((s) => s.exists).map(serialize)
}

/** The file's bytes, reassembled and checked against its recorded size. */
export async function getFileBytes(file) {
  const snapshot = await db.collection(FILES_COLLECTION).doc(file.id).collection('parts').orderBy('__name__').get()
  const buffer = joinParts(snapshot.docs.map((d) => Buffer.from(d.data().data)))
  if (buffer.length !== file.sizeBytes) throw new Error(`File "${file.title}" is incomplete in storage (${buffer.length} of ${file.sizeBytes} bytes)`)
  return buffer
}

// Newest upload first; deleted files hidden. Filtered in memory (the library is small) so no index is needed.
export async function listFiles({ includeDeleted = false, limit = 500 } = {}) {
  const snapshot = await db.collection(FILES_COLLECTION).orderBy('uploadedAt', 'desc').limit(2000).get()
  return snapshot.docs.map(serialize).filter((f) => includeDeleted || !f.deleted).slice(0, limit)
}

// The same bytes uploaded for another date are a new version, so a match needs the same date too.
export async function findFileBySha256(sha256, reportDate = null) {
  const snapshot = await db.collection(FILES_COLLECTION).where('sha256', '==', sha256).limit(50).get()
  return snapshot.docs.map(serialize).find((f) => !f.deleted && (f.reportDate ?? null) === (reportDate ?? null)) ?? null
}

export async function updateFile(id, fields) {
  await db.collection(FILES_COLLECTION).doc(id).update(fields)
  return getFile(id)
}

export async function softDeleteFile(id) {
  await db.collection(FILES_COLLECTION).doc(id).update({ deleted: true, deletedAt: FieldValue.serverTimestamp() })
}
