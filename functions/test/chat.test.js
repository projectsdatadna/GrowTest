import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import ExcelJS from 'exceljs'
import { chooseFilesByDate, chooseFilesByVersion, selectFilesForRequest, buildFileParts, buildMessages, runChat, sheetToText, ChatError, MAX_FILES_PER_REQUEST } from '../assistant/chatEngine.js'
import { validateChatRequest, registerChatRoutes } from '../chatRoutes.js'
import { chatCompletion } from '../aiClient.js'

const NOW = new Date('2026-11-23T04:00:00Z')
const file = (id, reportDate, extra = {}) => ({ id, title: `FII ${reportDate}`, fileName: `fii-${reportDate}.pdf`, kind: 'pdf', reportDate, sizeBytes: 1000, mimeType: 'application/pdf', ...extra })
const library = [file('fileaaaaaaaa1', '2025-11-10'), file('fileaaaaaaaa2', '2025-11-14'), file('fileaaaaaaaa3', '2025-11-17'), file('fileaaaaaaaa4', null, { title: 'Undated' })]

test('dates -> files: one date, two dates, a range, "latest", a date with no file, no date at all', () => {
  const ids = (q) => chooseFilesByDate(q, library, { now: NOW })
  assert.deepEqual(ids('What did FIIs do on 14 Nov 2025?').fileIds, ['fileaaaaaaaa2'])
  assert.deepEqual(ids('Compare 14 Nov 2025 with 10 Nov 2025').fileIds, ['fileaaaaaaaa1', 'fileaaaaaaaa2'], 'chronological order')
  assert.deepEqual(ids('flows between 10 Nov 2025 and 14 Nov 2025').fileIds, ['fileaaaaaaaa1', 'fileaaaaaaaa2'])
  assert.deepEqual(ids('Summarise the latest report').fileIds, [], '"latest" is handled by chooseFilesByVersion')
  assert.deepEqual(ids('what is the current ratio?').fileIds, [])
  assert.deepEqual(ids('hello').fileIds, [])
  const missing = ids('What about 12 Nov 2025?')
  assert.deepEqual(missing.fileIds, [])
  assert.match(missing.note, /no stored file has that date\. Stored report dates: 2025-11-17, 2025-11-14, 2025-11-10\./)
  assert.match(ids('on 14 Nov 2025 and 12 Nov 2025').note, /2025-11-12/)
  assert.deepEqual(ids('on 14 Nov 2025 and 12 Nov 2025').fileIds, ['fileaaaaaaaa2'])
  const many = Array.from({ length: 8 }, (_, i) => file(`filemany0000${i}`, `2025-11-0${i + 1}`))
  assert.equal(chooseFilesByDate('between 1 Nov 2025 and 9 Nov 2025', many, { now: NOW }).fileIds.length, MAX_FILES_PER_REQUEST)
})

test('file caps: most recent kept, oldest dropped, by count and by total size', () => {
  const six = Array.from({ length: 6 }, (_, i) => file(`f${i}`, `2025-11-0${i + 1}`))
  const a = selectFilesForRequest(six)
  assert.deepEqual([a.included.map((x) => x.id), a.dropped.map((x) => x.id)], [['f1', 'f2', 'f3', 'f4', 'f5'], ['f0']])
  const big = [file('b0', null, { sizeBytes: 12e6 }), file('b1', null, { sizeBytes: 9e6 }), file('b2', null, { sizeBytes: 9e6 })]
  const b = selectFilesForRequest(big)
  assert.deepEqual([b.included.map((x) => x.id), b.dropped.map((x) => x.id)], [['b1', 'b2'], ['b0']])
})

test('file parts: a label then the PDF as a base64 file part; a sheet as markdown text', async () => {
  const workbook = new ExcelJS.Workbook()
  workbook.addWorksheet('Rates').addRows([['Symbol', 'Lot'], ['VEDL', 1150]])
  const xlsx = Buffer.from(await workbook.xlsx.writeBuffer())
  const sheet = file('s1', '2025-11-14', { fileName: 'rates.xlsx', kind: 'sheet', title: 'Rates' })
  const pdf = file('p1', '2025-11-10')
  const bytes = { s1: xlsx, p1: Buffer.from('%PDF-1.4 hi') }
  const { parts, truncated } = await buildFileParts([pdf, sheet], { getBytes: async (f) => bytes[f.id] })
  assert.deepEqual(truncated, [])
  assert.equal(parts[0].text, 'File 1: "FII 2025-11-10" (fii-2025-11-10.pdf); report date: 2025-11-10')
  assert.deepEqual(parts[1], { type: 'file', file: { filename: 'fii-2025-11-10.pdf', file_data: `data:application/pdf;base64,${Buffer.from('%PDF-1.4 hi').toString('base64')}` } })
  assert.match(parts[2].text, /File 2: "Rates" \(rates.xlsx\); report date: 2025-11-14/)
  assert.match(parts[3].text, /### Rates rows 2-2\n\| Symbol \| Lot \|\n\| --- \| --- \|\n\| VEDL \| 1150 \|/)
})

test('long sheets are cut at the cap on a line / section boundary, with a note; csv is sent raw', async () => {
  const csvFile = { fileName: 'big.csv', title: 'Big' }
  const rows = Array.from({ length: 1000 }, (_, i) => `2026-11-23,SYM${i},${100 + i}.5`).join('\n')
  const small = await sheetToText(csvFile, Buffer.from('\uFEFFDate,Symbol,Close\n2026-11-23,VEDL,237.85\n'))
  assert.deepEqual(small, { text: 'Date,Symbol,Close\n2026-11-23,VEDL,237.85\n', truncated: false })
  const cut = await sheetToText(csvFile, Buffer.from(`Date,Symbol,Close\n${rows}`), { maxChars: 2000 })
  assert.equal(cut.truncated, true)
  assert.match(cut.text, /\[truncated - showing the first \d+ of 1001 lines/)
  const body = cut.text.split('\n[truncated')[0]
  assert.ok(body.length <= 2000 && !body.endsWith(','), 'cut on a whole line')
  assert.ok(body.split('\n').every((l) => l.split(',').length === 3), 'no half lines')
  const workbook = new ExcelJS.Workbook()
  const ws = workbook.addWorksheet('Data')
  ws.addRow(['Date', 'Symbol', 'Close'])
  for (let i = 0; i < 120; i += 1) ws.addRow(['2026-11-23', `SYM${i}`, 100 + i])
  const xlsx = Buffer.from(await workbook.xlsx.writeBuffer())
  const whole = await sheetToText({ fileName: 'a.xlsx' }, xlsx)
  assert.equal(whole.truncated, false)
  const part = await sheetToText({ fileName: 'a.xlsx' }, xlsx, { maxChars: 2000 })
  assert.equal(part.truncated, true)
  assert.match(part.text, /\[truncated - showing 1 of 3 sections/)
  const { truncated } = await buildFileParts([{ ...csvFile, kind: 'sheet', title: 'Big' }], { getBytes: async () => Buffer.from('a,b\n1,2\n') })
  assert.deepEqual(truncated, [])
})

test('messages: system, files first, history, then the question with the note appended', () => {
  const parts = [{ type: 'text', text: 'File 1' }]
  const history = [{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }, { role: 'system', content: 'ignored' }, { role: 'user', content: '' }]
  const m = buildMessages({ now: NOW, parts, history, message: 'q2', note: 'No file for 12 Nov.' })
  assert.deepEqual(m.map((x) => x.role), ['system', 'user', 'user', 'assistant', 'user'])
  assert.match(m[0].content, /Today's date is 2026-11-23/)
  assert.equal(m[1].content[0].text, 'These are the files attached to this conversation:')
  assert.equal(m[1].content[1], parts[0])
  assert.match(m.at(-1).content, /^q2\n\n\[Note for the assistant, not written by the user: No file for 12 Nov\.\]$/)
  const none = buildMessages({ now: NOW, parts: [], history: [], message: 'hi' })
  assert.deepEqual(none.map((x) => x.role), ['system', 'user'])
  assert.match(none[1].content, /No file is attached to this conversation yet/)
})

function fakeDeps(over = {}) {
  const state = { conversations: new Map(), messages: new Map(), calls: [], usage: [] }
  return {
    state,
    deps: {
      now: NOW,
      conversations: {
        create: async ({ title }) => { const c = { id: 'convaaaaaaaa1', title, fileIds: [] }; state.conversations.set(c.id, c); state.messages.set(c.id, []); return c },
        get: async (id) => state.conversations.get(id) ?? null,
        setFiles: async (id, ids) => { state.conversations.get(id).fileIds = ids },
        listMessages: async (id) => [...state.messages.get(id)],
        appendMessages: async (id, m) => { state.messages.get(id).push(...m) },
      },
      files: { list: async () => library, getBytes: async () => Buffer.from('%PDF-1.4 x') },
      chat: async (messages) => { state.calls.push(messages); return { message: { content: ' The net short was 60,000 contracts (FII 14 Nov, p.2). ' }, usage: { total_tokens: 1800 } } },
      logUsage: async (e) => state.usage.push(e),
      ...over,
    },
  }
}

test('runChat: a new conversation with an attached file -> one model call with the file, answer saved, conversation keeps the file', async () => {
  const { deps, state } = fakeDeps()
  const result = await runChat({ message: 'What was the net position?', fileIds: ['fileaaaaaaaa2'] }, deps)
  assert.equal(result.answer, 'The net short was 60,000 contracts (FII 14 Nov, p.2).')
  assert.equal(result.conversationId, 'convaaaaaaaa1')
  assert.deepEqual(result.files.map((f) => f.id), ['fileaaaaaaaa2'])
  assert.deepEqual(result.newlyAttached.map((f) => [f.id, f.auto]), [['fileaaaaaaaa2', false]])
  assert.equal(state.calls.length, 1)
  assert.equal(state.calls[0][1].content[2].type, 'file')
  assert.deepEqual(state.conversations.get('convaaaaaaaa1').fileIds, ['fileaaaaaaaa2'])
  assert.deepEqual(state.messages.get('convaaaaaaaa1').map((m) => [m.role, m.fileIds]), [['user', ['fileaaaaaaaa2']], ['assistant', undefined]])
  assert.deepEqual(state.usage.map((u) => [u.feature, u.metadata.files]), [['file_chat', 1]])
})

test('runChat: follow-up reuses the conversation files and history; a date in the question auto-attaches that file', async () => {
  const { deps, state } = fakeDeps()
  await runChat({ message: 'first', fileIds: ['fileaaaaaaaa2'] }, deps)
  const second = await runChat({ conversationId: 'convaaaaaaaa1', message: 'And compare with 10 Nov 2025' }, deps)
  assert.deepEqual(second.files.map((f) => f.id), ['fileaaaaaaaa2', 'fileaaaaaaaa1'])
  assert.deepEqual(second.newlyAttached.map((f) => [f.id, f.auto]), [['fileaaaaaaaa1', true]])
  const sent = state.calls[1]
  assert.equal(sent.filter((m) => m.role === 'assistant').length, 1, 'earlier answer is in the history')
  assert.equal(sent[1].content.filter((p) => p.type === 'file').length, 2, 'both files are sent')
  assert.deepEqual(state.conversations.get('convaaaaaaaa1').fileIds, ['fileaaaaaaaa2', 'fileaaaaaaaa1'])
  assert.equal(state.messages.get('convaaaaaaaa1').length, 4)
  const third = await runChat({ conversationId: 'convaaaaaaaa1', message: 'thanks' }, deps)
  assert.deepEqual(third.newlyAttached, [])
})

test('runChat: a date with no file reaches the model as a note; no file at all is allowed', async () => {
  const { deps, state } = fakeDeps()
  const r = await runChat({ message: 'What did FIIs do on 12 Nov 2025?' }, deps)
  assert.deepEqual(r.files, [])
  assert.match(state.calls[0].at(-1).content, /no stored file has that date/)
  assert.match(state.calls[0].at(-1).content, /No file is attached/)
})

test('runChat: errors - unknown conversation, deleted file, empty model answer; nothing is saved on failure', async () => {
  const { deps, state } = fakeDeps({ chat: async () => ({ message: { content: '  ' } }) })
  await assert.rejects(runChat({ conversationId: 'convmissing001', message: 'x' }, deps), (e) => e instanceof ChatError && e.status === 404)
  await assert.rejects(runChat({ message: 'x', fileIds: ['filegone00001'] }, deps), (e) => e.status === 400)
  await assert.rejects(runChat({ message: 'x', fileIds: ['fileaaaaaaaa2'] }, deps), (e) => e.status === 502)
  assert.equal(state.conversations.size, 0)
  const failing = fakeDeps({ chat: async () => { throw new Error('Chat request failed (429): slow down') } })
  await assert.rejects(runChat({ message: 'x' }, failing.deps), /429/)
  assert.equal(failing.state.conversations.size, 0)
})

test('azure client: sends messages (with file parts) as given, returns message + usage, explains failures', async () => {
  let sent
  const http = { post: async (url, body) => { sent = { url, body }; return { data: { usage: { total_tokens: 9 }, choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] } } } }
  const config = { apiKey: 'k', endpoint: 'https://e.openai.azure.com/', deployment: 'chat', apiVersion: '2024-08-01-preview' }
  const messages = [{ role: 'user', content: [{ type: 'file', file: { filename: 'a.pdf', file_data: 'data:application/pdf;base64,AAA' } }] }]
  const out = await chatCompletion(messages, config, {}, { http })
  assert.equal(sent.url, 'https://e.openai.azure.com/openai/deployments/chat/chat/completions?api-version=2024-08-01-preview')
  assert.deepEqual(sent.body.messages, messages)
  assert.deepEqual([out.message.content, out.usage.total_tokens], ['ok', 9])
  await assert.rejects(chatCompletion([], { ...config, apiKey: '' }, {}, { http }), /config incomplete/)
  await assert.rejects(chatCompletion([], config, {}, { http: { post: async () => { throw Object.assign(new Error('x'), { response: { status: 401, data: { error: { message: 'bad key' } } } }) } } }), /\(401\): bad key/)
})

test('chat request validation', () => {
  assert.match(validateChatRequest({}).error, /Type a question/)
  assert.match(validateChatRequest({ message: 'x'.repeat(4001) }).error, /longer/)
  assert.match(validateChatRequest({ message: 'x', conversationId: 'bad id' }).error, /conversation id/)
  assert.match(validateChatRequest({ message: 'x', fileIds: ['bad id'] }).error, /Attach up to/)
  assert.match(validateChatRequest({ message: 'x', fileIds: Array.from({ length: 6 }, (_, i) => `file00000000${i}`) }).error, /Attach up to 5/)
  assert.deepEqual(validateChatRequest({ message: ' hi ', fileIds: ['fileaaaaaaaa1', 'fileaaaaaaaa1'] }).value, { message: 'hi', conversationId: null, fileIds: ['fileaaaaaaaa1'] })
})

async function startApp(depsOver) {
  const { deps, state } = fakeDeps(depsOver)
  const filesStore = { listFiles: deps.files.list, getFileBytes: deps.files.getBytes, getFiles: async (ids) => library.filter((f) => ids.includes(f.id)) }
  const convStore = { createConversation: deps.conversations.create, getConversation: deps.conversations.get, setConversationFiles: deps.conversations.setFiles, listMessages: deps.conversations.listMessages, appendMessages: deps.conversations.appendMessages }
  const app = express()
  app.use(express.json())
  registerChatRoutes(app, { conversations: convStore, files: filesStore, chat: deps.chat, logUsage: deps.logUsage })
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)) })
  return { state, base: `http://localhost:${server.address().port}`, close: () => { server.closeAllConnections(); server.close() } }
}
const post = (base, body) => fetch(`${base}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

test('POST /chat + GET /chat/conversations/:id: answer as JSON, then the chat can be restored', async () => {
  const { base, close } = await startApp()
  const res = await post(base, { message: 'Net position on 14 Nov 2025?' })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.deepEqual([body.status, body.conversationId, body.files.map((f) => f.id)], ['SUCCESS', 'convaaaaaaaa1', ['fileaaaaaaaa2']])
  assert.equal(body.newlyAttached[0].auto, true)
  const restored = await (await fetch(`${base}/chat/conversations/${body.conversationId}`)).json()
  assert.deepEqual(restored.messages.map((m) => m.role), ['user', 'assistant'])
  assert.deepEqual(restored.files.map((f) => f.title), ['FII 2025-11-14'])
  assert.ok(!('sizeBytes' in restored.files[0]) || restored.files[0].sizeBytes === 1000)
  assert.equal((await fetch(`${base}/chat/conversations/bad!`)).status, 400)
  assert.equal((await fetch(`${base}/chat/conversations/convmissing001`)).status, 404)
  close()
})

test('POST /chat: validation 400, unknown conversation 404, model failure 502, other failure 500', async () => {
  let failure = new Error('Chat request failed (429): slow down')
  const { base, close } = await startApp({ chat: async () => { throw failure } })
  assert.equal((await post(base, { message: '' })).status, 400)
  assert.equal((await post(base, { message: 'x', conversationId: 'convmissing001' })).status, 404)
  const bad = await post(base, { message: 'x' })
  assert.deepEqual([bad.status, (await bad.json()).error], [502, 'Chat request failed (429): slow down'])
  failure = new Error('boom')
  assert.equal((await post(base, { message: 'x' })).status, 500)
  close()
})

const ver = (id, fileName, reportDate, uploadedAt) => ({ id, title: fileName.replace(/\.[^.]+$/, ''), fileName, kind: 'pdf', reportDate, uploadedAt, sizeBytes: 1000, mimeType: 'application/pdf' })
const versions = [
  ver('fileversion01', 'FII Report 10-11-2025.pdf', '2025-11-10', '2025-11-10T05:00:00Z'),
  ver('fileversion02', 'FII Report 14-11-2025.pdf', '2025-11-14', '2025-11-14T05:00:00Z'),
  ver('fileversion03', 'FII Report.pdf', '2025-11-20', '2025-11-20T05:00:00Z'),
  ver('filedii000001', 'DII Flows 12-11-2025.pdf', '2025-11-12', '2025-11-12T05:00:00Z'),
]

test('versions -> files: current + previous of one document; latest alone; named document; dates still win; one version = honest note', () => {
  const pick = (q, lib = versions, conversationFiles = []) => chooseFilesByVersion(q, lib, { conversationFiles, now: NOW })
  const fii = pick('Compare the current and previous FII report')
  assert.deepEqual(fii.fileIds, ['fileversion02', 'fileversion03'])
  assert.deepEqual(fii.roles, { fileversion02: 'previous', fileversion03: 'current' })
  assert.deepEqual(pick('what changed since the previous version?', versions, [versions[3]]).fileIds, ['filedii000001'], 'one version of the conversation document: nothing to compare')
  assert.match(pick('what changed since the previous version?', versions, [versions[3]]).note, /Only one version of "DII Flows 12-11-2025" is stored/)
  assert.deepEqual(pick('compare with the previous DII flows').fileIds, ['filedii000001'], 'the question names the document')
  assert.deepEqual(pick('what changed since the previous version?', versions, [versions[0]]).fileIds, ['fileversion02', 'fileversion03'], 'the conversation document')
  assert.deepEqual(pick('Summarise the latest report').fileIds, ['fileversion03'], 'newest upload overall, only that one')
  assert.deepEqual(pick('what is the current ratio?').fileIds, [])
  assert.deepEqual(pick('hello').fileIds, [])
  assert.deepEqual(pick('compare 14 Nov 2025 with the previous report').fileIds, [], 'explicit dates are handled by chooseFilesByDate')
  const twins = [...versions, ver('fileother0001', 'FII Other.pdf', '2025-11-22', '2025-11-22T05:00:00Z')]
  assert.deepEqual(pick('compare the current and previous FII Report', twins).fileIds, ['fileversion02', 'fileversion03'], 'FII Report beats FII Other even though FII Other was uploaded last')
  const legacy = [ver('filelegacy001', 'Rates.csv', null, '2025-11-12T05:00:00Z'), ver('filelegacy002', 'Rates (1).csv', null, '2025-11-18T05:00:00Z')]
  assert.deepEqual(pick('compare rates with the previous version', legacy).fileIds, ['filelegacy001', 'filelegacy002'], 'undated files are ordered by upload day')
  assert.deepEqual(chooseFilesByDate('rates on 18 Nov 2025', legacy, { now: NOW }).fileIds, ['filelegacy002'], 'and found by their upload day')
})

test('file label tells the model which version it is', async () => {
  const { parts } = await buildFileParts([versions[1], versions[2]], { getBytes: async () => Buffer.from('%PDF-1.4 x'), versions: (await import('../assistant/fileFamily.js')).versionInfo(versions) })
  assert.equal(parts[0].text, 'File 1: "FII Report 14-11-2025" (FII Report 14-11-2025.pdf); report date: 2025-11-14; uploaded: 2025-11-14; version 2 of 3 of this document')
  assert.match(parts[2].text, /version 3 of 3 of this document/)
})

test('runChat: "compare the current and previous FII report" attaches both versions, labelled, without any dates in the question', async () => {
  const { deps, state } = fakeDeps({ files: { list: async () => versions, getBytes: async () => Buffer.from('%PDF-1.4 x') } })
  const r = await runChat({ message: 'Compare the current and previous FII report', fileIds: ['fileversion03'] }, deps)
  assert.deepEqual(r.files.map((f) => f.id).sort(), ['fileversion02', 'fileversion03'])
  assert.deepEqual(Object.fromEntries(r.newlyAttached.map((f) => [f.id, [f.auto, f.role]])), { fileversion03: [false, 'current'], fileversion02: [true, 'previous'] })
  const labels = state.calls[0][1].content.filter((p) => p.type === 'text').map((p) => p.text).join('\n')
  assert.match(labels, /version 2 of 3 of this document/)
  assert.match(labels, /version 3 of 3 of this document/)
})
