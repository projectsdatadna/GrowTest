/**
 * PDF -> per-page text with unpdf (serverless build of pdf.js; no native deps).
 * Text only: a scanned (image) PDF has no text layer and is reported as such
 * instead of being silently indexed as empty - OCR is a separate, later step.
 */

import { extractText, getDocumentProxy } from 'unpdf'

const MIN_PAGE_CHARS = 30

export async function parsePdf(buffer) {
  const pdf = await getDocumentProxy(new Uint8Array(buffer))
  const { totalPages, text } = await extractText(pdf, { mergePages: false })
  const pages = text.map((pageText, i) => ({ page: i + 1, text: String(pageText).replace(/[ \t]+\n/g, '\n').trim() }))
  const withText = pages.filter((p) => p.text.length >= MIN_PAGE_CHARS)
  return {
    pageCount: totalPages,
    pages: withText,
    emptyPages: pages.length - withText.length,
    // Most pages have no text layer -> scanned document.
    needsOcr: pages.length > 0 && withText.length < pages.length / 2,
  }
}
