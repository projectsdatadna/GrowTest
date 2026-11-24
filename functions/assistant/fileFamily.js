/**
 * Which stored files are versions of one document. Pure.
 *
 * The same document uploaded on different days usually keeps its name apart from a date or a copy
 * marker ("FII_Report_14-11-2025.pdf", "FII Report 20 Nov 2025 (1).pdf"), so the name with those removed
 * is the document's key. A version's date is its report date, else the day it was uploaded (IST).
 */

import { stripDates } from '../ingest/reportDate.js'

export function familyKey(file) {
  const base = String(file.fileName || file.title || '').replace(/\.[A-Za-z0-9]+$/, '')
  const key = stripDates(base)
    .toLowerCase()
    .replace(/\(\d+\)/g, ' ')
    .replace(/\b(copy|v\d+)\b/g, ' ')
    .replace(/[^a-z0-9&]+/g, ' ')
    .trim()
  return key || 'file'
}

/** IST calendar date (YYYY-MM-DD) of an ISO timestamp, or '' when there is none. */
export function istDay(iso) {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? new Date(t + 5.5 * 3600000).toISOString().slice(0, 10) : ''
}

export const effectiveDate = (file) => file.reportDate || istDay(file.uploadedAt)

/** Oldest first: by date, then by upload time. */
export function orderVersions(files) {
  return [...files].sort((a, b) => effectiveDate(a).localeCompare(effectiveDate(b)) || String(a.uploadedAt || '').localeCompare(String(b.uploadedAt || '')) || a.id.localeCompare(b.id))
}

/** Files grouped by document: Map<familyKey, files oldest -> newest>. */
export function groupFamilies(library) {
  const groups = new Map()
  for (const file of library) {
    const key = familyKey(file)
    groups.set(key, [...(groups.get(key) ?? []), file])
  }
  for (const [key, files] of groups) groups.set(key, orderVersions(files))
  return groups
}

/** Map<fileId, { n, of, familyKey }> - "version n of of" within its document. */
export function versionInfo(library) {
  const info = new Map()
  for (const [key, files] of groupFamilies(library)) files.forEach((f, i) => info.set(f.id, { n: i + 1, of: files.length, familyKey: key }))
  return info
}

/** The newest version and the one before it (an earlier date if there is one, else the upload before it). */
export function currentAndPrevious(versions) {
  const ordered = orderVersions(versions)
  const current = ordered[ordered.length - 1]
  if (!current) return { current: null, previous: null }
  const earlier = ordered.slice(0, -1)
  const previous = [...earlier].reverse().find((f) => effectiveDate(f) < effectiveDate(current)) ?? earlier[earlier.length - 1] ?? null
  return { current, previous }
}
