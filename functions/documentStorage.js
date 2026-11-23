/**
 * Cloud Storage side of the document store. The bucket is private (no public
 * access, deny-all storage.rules); the browser uploads straight to a resumable
 * session URL created here, so file size is not limited by the API's request
 * body size, and downloads are streamed through the API.
 * Bucket CORS must allow the app origin: see storage.cors.json.
 */

import admin from 'firebase-admin'
import { getStorage } from 'firebase-admin/storage'

export function documentsBucket() {
  const name = process.env.DOCUMENTS_BUCKET
  if (!name) throw new Error('DOCUMENTS_BUCKET is not set - create the Cloud Storage bucket and set its name (see .env.example)')
  if (admin.apps.length === 0) admin.initializeApp({ projectId: 'dev-cogniglob' })
  return getStorage(admin.app()).bucket(name)
}

export function storagePathFor(docId, fileName) {
  return `documents/${docId}/${fileName}`
}

/** One-time resumable upload session the browser PUTs the file to. `origin` = the page's origin (CORS). */
export async function createResumableUploadUrl(storagePath, { contentType, origin }) {
  const [url] = await documentsBucket().file(storagePath).createResumableUpload({ metadata: { contentType }, origin })
  return url
}

/** { exists, size } of an uploaded object. */
export async function statFile(storagePath) {
  const file = documentsBucket().file(storagePath)
  const [exists] = await file.exists()
  if (!exists) return { exists: false, size: 0 }
  const [metadata] = await file.getMetadata()
  return { exists: true, size: Number(metadata.size) || 0 }
}

export async function downloadFile(storagePath) {
  const [buffer] = await documentsBucket().file(storagePath).download()
  return buffer
}

export function openReadStream(storagePath) {
  return documentsBucket().file(storagePath).createReadStream()
}
