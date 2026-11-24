import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import ExcelJS from 'exceljs'
import { splitIntoParts, joinParts, PART_BYTES } from '../filesFirestoreClient.js'
import { validateUpload, sniffContent, safeFileName, MAX_FILE_BYTES } from '../ingest/uploadRequest.js'
import { detectReportDate, findDateIn, isoDate } from '../ingest/reportDate.js'
import { parseXlsx, parseCsvBuffer } from '../ingest/parseSheet.js'
import { registerFileRoutes } from '../fileRoutes.js'

const NOW = new Date('2026-11-23T00:00:00Z')

test('parts: split to <= 800 KB, join restores the exact bytes, empty gives no parts', () => {
  const big = Buffer.from(Array.from({ length: PART_BYTES * 2 + 123 }, (_, i) => i % 251))
  const parts = splitIntoParts(big)
  assert.deepEqual(parts.map((p) => p.length), [PART_BYTES, PART_BYTES, 123])
  assert.ok(joinParts(parts).equals(big))
  assert.equal(splitIntoParts(Buffer.alloc(0)).length, 0)
  assert.equal(splitIntoParts(Buffer.alloc(PART_BYTES)).length, 1)
})

test('report date: Indian day-first formats, names, compact, validity, filename before text', () => {
  const f = (s) => findDateIn(s, { now: NOW })
  assert.equal(f('FII_Report_2025-11-14'), '2025-11-14')
  assert.equal(f('FII DII 14-11-2025'), '2025-11-14')
  assert.equal(f('as on 14th Nov 2025'), '2025-11-14')
  assert.equal(f('Nov 14, 2025'), '2025-11-14')
  assert.equal(f('14-Nov-25'), '2025-11-14')
  assert.equal(f('fii_14112025'), '2025-11-14')
  assert.equal(f('31/02/2025'), null)
  assert.equal(isoDate(1999, 1, 1, { now: NOW }), null)
  assert.deepEqual(detectReportDate({ fileName: 'fii_14-11-2025.pdf', text: 'as on 10 Nov 2025' }, { now: NOW }), { date: '2025-11-14', source: 'filename' })
  assert.equal(detectReportDate({ fileName: 'report.pdf' }, { now: NOW }), null)
})

test('upload validation: type, size, date from header or file name, safe names', () => {
  const ok = { fileName: 'FII 14-11-2025.pdf', sizeBytes: 1000 }
  const good = validateUpload(ok, { now: NOW })
  assert.deepEqual([good.value.kind, good.value.mimeType, good.value.reportDate, good.value.reportDateSource, good.value.title], ['pdf', 'application/pdf', '2025-11-14', 'filename', 'FII 14-11-2025'])
  assert.equal(validateUpload({ ...ok, reportDate: '2025-11-10' }, { now: NOW }).value.reportDateSource, 'user')
  const undated = validateUpload({ fileName: 'notes.csv', sizeBytes: 5 }, { now: new Date('2025-11-20T20:00:00Z') }).value
  assert.deepEqual([undated.reportDate, undated.reportDateSource], ['2025-11-21', 'upload'], 'no date anywhere: the upload day in IST')
  assert.equal(validateUpload({ fileName: 'a.xlsx', sizeBytes: 5 }).value.kind, 'sheet')
  assert.match(validateUpload({ fileName: 'x.exe', sizeBytes: 5 }).error, /Unsupported/)
  assert.match(validateUpload({ ...ok, sizeBytes: MAX_FILE_BYTES + 1 }).error, /larger than 9 MB/)
  assert.match(validateUpload({ ...ok, sizeBytes: 0 }).error, /empty/)
  assert.match(validateUpload({ ...ok, reportDate: '2025-13-45' }, { now: NOW }).error, /valid date/)
  assert.equal(safeFileName('../../etc/passwd'), 'passwd')
  assert.equal(safeFileName('a<b>c?.pdf'), 'a_b_c_.pdf')
})

test('content sniffing: pdf / xlsx / csv must look like what the extension says', () => {
  assert.equal(sniffContent(Buffer.from('%PDF-1.4 ...'), 'pdf'), null)
  assert.match(sniffContent(Buffer.from('<html>'), 'pdf'), /not a valid PDF/)
  assert.equal(sniffContent(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1]), 'xlsx'), null)
  assert.match(sniffContent(Buffer.from('hello'), 'xlsx'), /not a valid .xlsx/)
  assert.equal(sniffContent(Buffer.from('a,b\n1,2'), 'csv'), null)
  assert.match(sniffContent(Buffer.from([97, 0, 98]), 'csv'), /CSV/)
})

test('sheet parsing: markdown tables, header repeated every 40 rows, formulas resolved, csv with BOM', async () => {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('FII Data')
  sheet.addRow(['Date', 'Segment', 'Net'])
  for (let i = 1; i <= 90; i += 1) sheet.addRow([new Date(Date.UTC(2025, 10, 1)), `seg|${i}`, { formula: 'A1', result: i * 10 }])
  workbook.addWorksheet('Empty')
  const parsed = await parseXlsx(Buffer.from(await workbook.xlsx.writeBuffer()))
  assert.equal(parsed.pageCount, 3)
  assert.equal(parsed.pages[0].label, 'FII Data rows 2-41')
  assert.ok(parsed.pages[1].text.startsWith('| Date | Segment | Net |'))
  assert.match(parsed.pages[0].text, /\| 2025-11-01 \| seg\\\|1 \| 10 \|/)
  const csv = parseCsvBuffer(Buffer.from('﻿Symbol,Lot\nVEDL,1150\nITC,1725\n'))
  assert.match(csv.pages[0].text, /\| VEDL \| 1150 \|/)
})

// ---- routes, with an in-memory store ----
function memoryStore() {
  const files = new Map()
  let n = 0
  return {
    files,
    createFile: async (meta, buffer) => { const id = `file${String(++n).padStart(8, '0')}`; const f = { id, ...meta, partCount: 1, deleted: false, uploadedAt: new Date(2026, 10, n).toISOString(), bytes: buffer }; files.set(id, f); return f },
    getFile: async (id) => files.get(id) ?? null,
    getFileBytes: async (f) => files.get(f.id).bytes,
    listFiles: async () => [...files.values()].filter((f) => !f.deleted).reverse(),
    findFileBySha256: async (sha, date = null) => [...files.values()].find((f) => f.sha256 === sha && !f.deleted && (f.reportDate ?? null) === date) ?? null,
    updateFile: async (id, fields) => Object.assign(files.get(id), fields),
    softDeleteFile: async (id) => { files.get(id).deleted = true },
  }
}
async function start() {
  const store = memoryStore()
  const app = express()
  app.use(express.json())
  registerFileRoutes(app, { store })
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)) })
  return { store, base: `http://localhost:${server.address().port}`, close: () => { server.closeAllConnections(); server.close() } }
}
const upload = (base, name, body, headers = {}) => fetch(`${base}/files`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name), ...headers }, body })

test('POST /files: stores, detects the date, dedupes by content, rejects bad type / fake PDF / empty / oversize', async () => {
  const { base, store, close } = await start()
  const pdf = Buffer.from('%PDF-1.4 hello world')
  const created = await upload(base, 'FII 14-11-2025.pdf', pdf)
  assert.equal(created.status, 201)
  const body = await created.json()
  assert.deepEqual([body.file.title, body.file.reportDate, body.file.kind, body.file.sizeBytes], ['FII 14-11-2025', '2025-11-14', 'pdf', pdf.length])
  assert.ok(!('sha256' in body.file) && !('bytes' in body.file))
  assert.ok(store.files.get(body.file.id).bytes.equals(pdf))
  const again = await (await upload(base, 'FII 14-11-2025 (1).pdf', pdf)).json()
  assert.equal(again.duplicate, true)
  assert.equal(again.file.id, body.file.id)
  assert.equal(store.files.size, 1)
  assert.deepEqual([again.version, again.siblings], [{ n: 1, of: 1 }, []])
  // The same bytes for another date are the next version of the same document, not a duplicate.
  const v2 = await upload(base, 'FII 20-11-2025.pdf', pdf)
  assert.equal(v2.status, 201)
  const v2body = await v2.json()
  assert.deepEqual([v2body.duplicate, v2body.file.reportDate, v2body.version, v2body.siblings.map((s) => s.reportDate)], [false, '2025-11-20', { n: 2, of: 2 }, ['2025-11-14']])
  assert.equal((await (await upload(base, 'FII 20-11-2025.pdf', pdf)).json()).duplicate, true, 'same bytes and same date: reused')
  assert.equal(store.files.size, 2)
  store.files.delete(v2body.file.id)
  const dated = await upload(base, 'other.pdf', Buffer.from('%PDF-1.4 different'), { 'x-report-date': '2025-11-10', 'x-title': encodeURIComponent('My report') })
  assert.deepEqual([(await dated.json()).file.reportDate], ['2025-11-10'])
  assert.equal((await upload(base, 'x.exe', Buffer.from('MZ'))).status, 400)
  assert.equal((await upload(base, 'fake.pdf', Buffer.from('<html>nope</html>'))).status, 422)
  assert.equal((await upload(base, 'e.pdf', Buffer.alloc(0))).status, 400)
  assert.equal((await upload(base, 'bad.pdf', Buffer.from('%PDF-1.4 x'), { 'x-report-date': '2025-99-99' })).status, 400)
  const huge = await upload(base, 'big.pdf', Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(MAX_FILE_BYTES + 2 * 1024 * 1024)]))
  assert.equal(huge.status, 413)
  assert.match((await huge.json()).error, /9 MB/)
  assert.equal((await fetch(`${base}/files`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' })).status, 400)
  close()
})

test('POST /files: spreadsheets are checked for readability; csv and xlsx accepted', async () => {
  const { base, close } = await start()
  assert.equal((await upload(base, 'rates.csv', Buffer.from('Symbol,Lot\nVEDL,1150\n'))).status, 201)
  assert.equal((await upload(base, 'empty.csv', Buffer.from('\n\n'))).status, 422)
  const workbook = new ExcelJS.Workbook()
  workbook.addWorksheet('S').addRows([['a', 'b'], [1, 2]])
  assert.equal((await upload(base, 'ok 2025-11-14.xlsx', Buffer.from(await workbook.xlsx.writeBuffer()))).status, 201)
  assert.equal((await upload(base, 'corrupt.xlsx', Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('garbage')]))).status, 422)
  close()
})

test('files API: list, rename / re-date, clear the date, download, soft delete, id and date validation', async () => {
  const { base, close } = await start()
  const { file } = await (await upload(base, 'r.pdf', Buffer.from('%PDF-1.4 abc'))).json()
  assert.equal((await (await fetch(`${base}/files`)).json()).files.length, 1)
  const patch = (body) => fetch(`${base}/files/${file.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const renamed = await (await patch({ title: ' New title ', reportDate: '2025-11-14' })).json()
  assert.deepEqual([renamed.file.title, renamed.file.reportDate, renamed.file.reportDateSource], ['New title', '2025-11-14', 'user'])
  assert.equal((await (await patch({ reportDate: null })).json()).file.reportDate, null)
  assert.equal((await patch({ title: '  ' })).status, 400)
  assert.equal((await patch({ reportDate: '14/11/2025' })).status, 400)
  const download = await fetch(`${base}/files/${file.id}/download`)
  assert.equal(download.headers.get('content-type'), 'application/pdf')
  assert.match(download.headers.get('content-disposition'), /r\.pdf/)
  assert.equal(Buffer.from(await download.arrayBuffer()).toString(), '%PDF-1.4 abc')
  assert.equal((await fetch(`${base}/files/bad!`)).status, 404)
  assert.equal((await fetch(`${base}/files/bad!`, { method: 'DELETE' })).status, 400)
  assert.equal((await fetch(`${base}/files/${file.id}`, { method: 'DELETE' })).status, 200)
  assert.equal((await fetch(`${base}/files/${file.id}/download`)).status, 404)
  assert.equal((await (await fetch(`${base}/files`)).json()).files.length, 0)
  close()
})
