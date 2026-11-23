import test from 'node:test'
import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'
import { chunkPages, embeddingText, approxTokens } from '../ingest/chunker.js'
import { detectReportDate, findDateIn, isoDate } from '../ingest/reportDate.js'
import { parsePdf } from '../ingest/parsePdf.js'
import { parseXlsx, parseCsvBuffer } from '../ingest/parseSheet.js'
import { validateUploadRequest, safeFileName } from '../ingest/uploadRequest.js'

// Minimal text-only PDF, one page per entry (correct xref so any reader accepts it).
function buildPdf(pageTexts) {
  const objects = []
  const add = (body) => objects.push(body) && objects.length
  add('<< /Type /Catalog /Pages 2 0 R >>')
  const kids = pageTexts.map((_, i) => `${4 + i * 2} 0 R`).join(' ')
  add(`<< /Type /Pages /Kids [${kids}] /Count ${pageTexts.length} >>`)
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  pageTexts.forEach((text, i) => {
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`)
    const stream = text ? `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, '')}) Tj ET` : ''
    add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  })
  let out = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((body, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return Buffer.from(out, 'latin1')
}

test('chunker: never crosses pages, keeps paragraphs, overlaps long pages, indexes in order', () => {
  const para = (n) => `Paragraph ${n}. ` + 'word '.repeat(150)
  const chunks = chunkPages([
    { page: 1, text: `${para(1)}\n\n${para(2)}\n\n${para(3)}\n\n${para(4)}\n\n${para(5)}` },
    { page: 2, text: 'Short second page.' },
  ], { maxTokens: 400, overlapTokens: 50 })
  assert.ok(chunks.length >= 3)
  assert.deepEqual(chunks.map((c) => c.chunkIdx), chunks.map((_, i) => i))
  assert.deepEqual([...new Set(chunks.map((c) => c.page))], [1, 2])
  assert.equal(chunks.at(-1).text, 'Short second page.')
  for (const c of chunks) assert.ok(approxTokens(c.text) <= 400 + 60, `chunk too big: ${approxTokens(c.text)}`)
  // overlap: the 2nd chunk of page 1 starts with text that ended the 1st
  const [a, b] = chunks
  const probe = b.text.slice(0, 40)
  assert.ok(a.text.includes(probe), 'second chunk should start with the tail of the first')
})

test('chunker: long tables split by rows with the header repeated; headings become the section', () => {
  const rows = Array.from({ length: 200 }, (_, i) => `| SYM${i} | ${i * 10} | ${i} |`).join('\n')
  const table = `| Symbol | Margin | Lot |\n| --- | --- | --- |\n${rows}`
  const chunks = chunkPages([{ page: 1, text: `FII ACTIVITY SUMMARY\n\n${table}`, label: 'Sheet1' }], { maxTokens: 300, overlapTokens: 0 })
  assert.ok(chunks.length > 1)
  const tableChunks = chunks.filter((c) => c.text.includes('| SYM'))
  for (const c of tableChunks) assert.ok(c.text.includes('| Symbol | Margin | Lot |'), 'header repeated')
  assert.equal(chunks[0].section, 'FII ACTIVITY SUMMARY')
  assert.equal(chunkPages([{ page: 3, text: '', label: 'x' }]).length, 0)
  const unbroken = chunkPages([{ page: 1, text: 'a'.repeat(10000) }], { maxTokens: 200, overlapTokens: 20 })
  assert.ok(unbroken.length > 1 && unbroken.every((c) => c.text.length <= 800))
})

test('embedding text carries title, date, page and section', () => {
  assert.equal(embeddingText({ title: 'FII Nov', reportDate: '2025-11-14', page: 2, section: 'Index Futures' }, 'body'), '[FII Nov | 2025-11-14 | p.2 | Index Futures]\nbody')
  assert.equal(embeddingText({ title: 'T', reportDate: null, page: 1, section: null }, 'x'), '[T | p.1]\nx')
})

test('report date: Indian day-first formats, names, compact, validity, filename before text', () => {
  const now = new Date('2026-11-23T00:00:00Z')
  const f = (s) => findDateIn(s, { now })
  assert.equal(f('FII_Report_2025-11-14'), '2025-11-14')
  assert.equal(f('FII DII 14-11-2025'), '2025-11-14')
  assert.equal(f('as on 14th Nov 2025'), '2025-11-14')
  assert.equal(f('Nov 14, 2025'), '2025-11-14')
  assert.equal(f('14-Nov-25'), '2025-11-14')
  assert.equal(f('fii_14112025'), '2025-11-14')
  assert.equal(f('fii_20251114'), '2025-11-14')
  assert.equal(f('31/02/2025'), null)
  assert.equal(f('no date here 12345'), null)
  assert.equal(isoDate(1999, 1, 1, { now }), null)
  assert.deepEqual(detectReportDate({ fileName: 'fii_14-11-2025.pdf', text: 'as on 10 Nov 2025' }, { now }), { date: '2025-11-14', source: 'filename' })
  assert.deepEqual(detectReportDate({ fileName: 'report.pdf', text: 'Daily FII statistics for 10 Nov 2025' }, { now }), { date: '2025-11-10', source: 'text' })
  assert.equal(detectReportDate({ fileName: 'report.pdf', text: 'nothing' }, { now }), null)
})

test('pdf parsing: text per page, empty pages dropped, image-only PDF flagged for OCR', async () => {
  const good = await parsePdf(buildPdf(['FII net sell in index futures was 1200 crore on this day', 'Page two has DII buying of 900 crore today']))
  assert.equal(good.pageCount, 2)
  assert.equal(good.needsOcr, false)
  assert.match(good.pages[0].text, /FII net sell in index futures/)
  assert.equal(good.pages[1].page, 2)
  const scanned = await parsePdf(buildPdf(['', '', 'tiny']))
  assert.equal(scanned.needsOcr, true)
  assert.equal(scanned.pageCount, 3)
})

test('xlsx / csv parsing: markdown tables, header repeated, row ranges as labels, formulas resolved', async () => {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('FII Data')
  sheet.addRow(['Date', 'Segment', 'Net'])
  for (let i = 1; i <= 90; i += 1) sheet.addRow([new Date(Date.UTC(2025, 10, 1)), `seg|${i}`, { formula: 'A1', result: i * 10 }])
  workbook.addWorksheet('Empty')
  const parsed = await parseXlsx(Buffer.from(await workbook.xlsx.writeBuffer()))
  assert.equal(parsed.pageCount, 3)
  assert.equal(parsed.pages[0].label, 'FII Data rows 2-41')
  assert.equal(parsed.pages[2].label, 'FII Data rows 82-91')
  assert.ok(parsed.pages[1].text.startsWith('| Date | Segment | Net |'))
  assert.match(parsed.pages[0].text, /\| 2025-11-01 \| seg\\\|1 \| 10 \|/)
  const csv = parseCsvBuffer(Buffer.from('﻿Symbol,Lot\nVEDL,1150\nITC,1725\n'))
  assert.equal(csv.pageCount, 1)
  assert.match(csv.pages[0].text, /\| VEDL \| 1150 \|/)
})

test('upload validation: type, size, hash, doc type, date rules, safe names', () => {
  const sha = 'a'.repeat(64)
  const ok = { fileName: 'FII 14-11-2025.pdf', sizeBytes: 1000, sha256: sha, docType: 'fii_report' }
  const now = new Date('2026-11-23T00:00:00Z')
  const good = validateUploadRequest(ok, { now })
  assert.equal(good.value.reportDate, '2025-11-14')
  assert.equal(good.value.reportDateSource, 'filename')
  assert.equal(good.value.title, 'FII 14-11-2025')
  assert.equal(validateUploadRequest({ ...ok, reportDate: '2025-11-10' }, { now }).value.reportDateSource, 'user')
  assert.match(validateUploadRequest({ ...ok, fileName: 'fii.pdf' }, { now }).error, /reportDate is required/)
  assert.equal(validateUploadRequest({ ...ok, fileName: 'notes.pdf', docType: 'general' }, { now }).value.reportDate, null)
  assert.match(validateUploadRequest({ ...ok, fileName: 'x.exe' }).error, /Unsupported/)
  assert.match(validateUploadRequest({ ...ok, sizeBytes: 60 * 1024 * 1024 }).error, /larger/)
  assert.match(validateUploadRequest({ ...ok, sha256: 'abc' }).error, /sha256/)
  assert.match(validateUploadRequest({ ...ok, reportDate: '2025-13-45' }, { now }).error, /valid date/)
  assert.match(validateUploadRequest({ ...ok, docType: 'x' }).error, /docType/)
  assert.equal(safeFileName('../../etc/passwd'), 'passwd')
  assert.equal(safeFileName('a<b>c?.pdf'), 'a_b_c_.pdf')
})

import { ingestDocument, IngestError, PARSER_VERSION } from '../ingest/ingestDocument.js'

function fakeDeps(doc, buffer, { embedFails = false } = {}) {
  const state = { doc: { ...doc }, chunks: null, usage: null, updates: [] }
  return {
    state,
    deps: {
      getDocument: async () => state.doc,
      updateDocument: async (_id, fields) => { state.updates.push(fields); Object.assign(state.doc, fields) },
      downloadFile: async () => buffer,
      replaceChunks: async (_id, chunks) => { state.chunks = chunks },
      embed: async (texts) => { if (embedFails) throw new Error('azure down'); state.embedded = texts; return { vectors: texts.map((t, i) => [i, t.length]), usage: { total_tokens: texts.length } } },
      logUsage: async (entry) => { state.usage = entry },
      embeddingModel: 'emb',
      now: () => new Date('2026-11-23T10:00:00Z'),
    },
  }
}
const baseDoc = { id: 'doc1', title: 'FII Nov', fileName: 'fii.pdf', extension: 'pdf', docType: 'fii_report', reportDate: '2025-11-14', reportDateSource: 'user', storagePath: 'documents/doc1/fii.pdf' }

test('ingest: parses, chunks, embeds with date/page prefix, stores vectors, marks ready, logs usage', async () => {
  const { state, deps } = fakeDeps(baseDoc, buildPdf(['FII net sell in index futures was 1200 crore on this day', 'DII net buy was 900 crore on this particular day']))
  const summary = await ingestDocument('doc1', deps)
  assert.equal(summary.status, 'ready')
  assert.equal(summary.pageCount, 2)
  assert.equal(summary.chunkCount, 2)
  assert.equal(summary.parserVersion, PARSER_VERSION)
  assert.deepEqual(state.updates[0], { status: 'processing', error: null })
  assert.match(state.embedded[0], /^\[FII Nov \| 2025-11-14 \| p\.1\]/)
  assert.deepEqual(state.chunks.map((c) => [c.page, c.reportDate, c.docType]), [[1, '2025-11-14', 'fii_report'], [2, '2025-11-14', 'fii_report']])
  assert.equal(state.chunks[0].embedding.length, 2)
  assert.equal(state.usage.feature, 'embed_chunks')
  assert.equal(state.usage.metadata.chunks, 2)
})

test('ingest: a general document without a date gets one detected from its text', async () => {
  const { state, deps } = fakeDeps({ ...baseDoc, docType: 'general', reportDate: null, reportDateSource: null }, buildPdf(['Weekly market outlook report as on 10 Nov 2025 for all clients here']))
  const summary = await ingestDocument('doc1', deps)
  assert.equal(summary.reportDate, '2025-11-10')
  assert.equal(summary.reportDateSource, 'text')
  assert.equal(state.chunks[0].reportDate, '2025-11-10')
})

test('ingest: scanned PDF, empty file and embedding failure end as failed with a reason (nothing stored)', async () => {
  const scanned = fakeDeps(baseDoc, buildPdf(['', '', '']))
  await assert.rejects(ingestDocument('doc1', scanned.deps), /no text layer/)
  assert.equal(scanned.state.doc.status, 'failed')
  assert.match(scanned.state.doc.error, /scanned/)
  assert.equal(scanned.state.chunks, null)

  const broken = fakeDeps(baseDoc, buildPdf(['A page with enough text to be indexed for sure']), { embedFails: true })
  await assert.rejects(ingestDocument('doc1', broken.deps), /azure down/)
  assert.equal(broken.state.doc.status, 'failed')
  assert.equal(broken.state.chunks, null)

  await assert.rejects(ingestDocument('doc1', { ...broken.deps, getDocument: async () => ({ ...baseDoc, deleted: true }) }), IngestError)
})
