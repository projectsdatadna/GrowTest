/**
 * Firestore side of the document store (uploaded PDFs / Excel / CSV). Files live
 * in Cloud Storage (documentStorage.js); here are their metadata and the
 * embedded text chunks the chatbot searches.
 *
 *   documents/{docId}        title, fileName, docType, reportDate, sha256, storagePath,
 *                            status (awaiting_upload|processing|ready|failed), tags, ...
 *   documentChunks/{docId}_{idx}  docId, chunkIdx, page, section, text, reportDate,
 *                            docType, embedding (vector, 1536)
 *
 * Nothing here ever expires. "Delete" is soft: the doc is flagged and its chunks
 * are removed from search, but the file and metadata stay.
 */

import admin from 'firebase-admin'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'

const PROJECT_ID = 'dev-cogniglob'
const DATABASE_ID = 'groww-dashboard'

if (admin.apps.length === 0) {
  admin.initializeApp({ projectId: PROJECT_ID })
}

const db = getFirestore(admin.app(), DATABASE_ID)
export const DOCUMENTS_COLLECTION = 'documents'
export const CHUNKS_COLLECTION = 'documentChunks'
const WRITE_BATCH = 100 // chunk docs carry a 1536-float vector (~12 KB each)

const iso = (value) => value?.toDate?.().toISOString() ?? value ?? null

function serialize(doc) {
  const data = doc.data()
  return { id: doc.id, ...data, uploadedAt: iso(data.uploadedAt), processedAt: iso(data.processedAt), deletedAt: iso(data.deletedAt) }
}

export async function createDocumentRecord(fields) {
  const ref = db.collection(DOCUMENTS_COLLECTION).doc()
  await ref.set({ ...fields, deleted: false, uploadedAt: FieldValue.serverTimestamp() })
  return ref.id
}

export async function getDocumentRecord(id) {
  const snapshot = await db.collection(DOCUMENTS_COLLECTION).doc(id).get()
  return snapshot.exists ? serialize(snapshot) : null
}

export async function updateDocumentRecord(id, fields) {
  const values = { ...fields }
  if (values.processedAt instanceof Date) values.processedAt = admin.firestore.Timestamp.fromDate(values.processedAt)
  await db.collection(DOCUMENTS_COLLECTION).doc(id).update(values)
}

// Newest first; filtered in memory (the library is small) so no composite index is needed.
export async function listDocumentRecords({ docType, status, from, to, includeDeleted = false, limit = 500 } = {}) {
  const snapshot = await db.collection(DOCUMENTS_COLLECTION).orderBy('uploadedAt', 'desc').limit(2000).get()
  return snapshot.docs
    .map(serialize)
    .filter((d) => includeDeleted || !d.deleted)
    .filter((d) => !docType || d.docType === docType)
    .filter((d) => !status || d.status === status)
    .filter((d) => !from || (d.reportDate && d.reportDate >= from))
    .filter((d) => !to || (d.reportDate && d.reportDate <= to))
    .slice(0, limit)
}

// A live (not soft-deleted) document with the same file contents, if any.
export async function findDocumentBySha256(sha256) {
  const snapshot = await db.collection(DOCUMENTS_COLLECTION).where('sha256', '==', sha256).limit(10).get()
  return snapshot.docs.map(serialize).find((d) => !d.deleted) ?? null
}

export async function deleteDocumentChunks(docId) {
  for (;;) {
    const snapshot = await db.collection(CHUNKS_COLLECTION).where('docId', '==', docId).limit(400).get()
    if (snapshot.empty) return
    const batch = db.batch()
    snapshot.docs.forEach((d) => batch.delete(d.ref))
    await batch.commit()
  }
}

/** chunks: [{ chunkIdx, page, section, text, embedding: number[], reportDate, docType }] */
export async function replaceDocumentChunks(docId, chunks) {
  await deleteDocumentChunks(docId)
  for (let i = 0; i < chunks.length; i += WRITE_BATCH) {
    const batch = db.batch()
    for (const { embedding, ...rest } of chunks.slice(i, i + WRITE_BATCH)) {
      batch.set(db.collection(CHUNKS_COLLECTION).doc(`${docId}_${String(rest.chunkIdx).padStart(5, '0')}`), { docId, ...rest, embedding: FieldValue.vector(embedding) })
    }
    await batch.commit()
  }
}

export async function softDeleteDocument(id) {
  await deleteDocumentChunks(id)
  await db.collection(DOCUMENTS_COLLECTION).doc(id).update({ deleted: true, deletedAt: FieldValue.serverTimestamp(), status: 'deleted' })
}

export async function getDocumentRecords(ids) {
  if (!ids.length) return []
  const snapshots = await db.getAll(...ids.map((id) => db.collection(DOCUMENTS_COLLECTION).doc(id)))
  return snapshots.filter((s) => s.exists).map(serialize)
}

/** Chunk texts of one document in reading order (for FII metric extraction). */
export async function listDocumentChunks(docId, { limit = 400 } = {}) {
  const snapshot = await db.collection(CHUNKS_COLLECTION).where('docId', '==', docId).get()
  return snapshot.docs
    .map((d) => {
      const { embedding, ...rest } = d.data()
      return { id: d.id, ...rest }
    })
    .sort((a, b) => a.chunkIdx - b.chunkIdx)
    .slice(0, limit)
}

/**
 * Vector search over the chunks (cosine). Filters (all optional):
 *   docIds  - only these documents (<= 30); a date filter then applies in memory
 *   docType - 'fii_report' | 'general'
 *   dates   - exactly these report dates (<= 30)
 *   from/to - report-date range, inclusive
 * Needs the vector indexes in firestore.indexes.json. Returns chunks best first,
 * without the embedding, with `distance` (0 = identical).
 */
export async function searchDocumentChunks({ vector, docIds, docType, dates, from, to, limit = 30 }) {
  let query = db.collection(CHUNKS_COLLECTION)
  if (docIds?.length) {
    query = query.where('docId', 'in', docIds.slice(0, 30))
  } else {
    if (docType) query = query.where('docType', '==', docType)
    if (dates?.length) query = query.where('reportDate', 'in', dates.slice(0, 30))
    else {
      if (from) query = query.where('reportDate', '>=', from)
      if (to) query = query.where('reportDate', '<=', to)
    }
  }
  const snapshot = await query.findNearest({ vectorField: 'embedding', queryVector: FieldValue.vector(vector), limit, distanceMeasure: 'COSINE', distanceResultField: '_distance' }).get()
  let chunks = snapshot.docs.map((d) => {
    const { embedding, _distance, ...rest } = d.data()
    return { id: d.id, ...rest, distance: _distance }
  })
  if (docIds?.length) {
    if (dates?.length) chunks = chunks.filter((c) => dates.includes(c.reportDate))
    else if (from || to) chunks = chunks.filter((c) => c.reportDate && (!from || c.reportDate >= from) && (!to || c.reportDate <= to))
  }
  return chunks
}
