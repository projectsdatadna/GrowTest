import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import ExcelJS from 'exceljs'
import { chooseFilesByDate, chooseFilesByVersion, selectFilesForRequest, buildFileParts, buildMessages, runChat, sheetToText, ChatError, MAX_FILES_PER_REQUEST } from '../assistant/chatEngine.js'
import { validateChatRequest, registerChatRoutes } from '../chatRoutes.js'
import { chatCompletion } from '../aiClient.js'
import { buildOptionChainContext, formatOptionChainBlock, changeSinceSnapshot, validateChatContext, istEpoch, SNAPSHOT_TIMES } from '../assistant/optionChainContext.js'
import { systemPrompt } from '../assistant/prompts.js'

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

test('chat request validation: option chain symbol + expiry and word limit are optional and checked', () => {
  const ok = validateChatRequest({ message: 'q', optionChain: { symbol: ' nifty ', expiryDate: '2026-12-02' }, wordLimit: 100 })
  assert.deepEqual(ok.value.optionChain, { symbol: 'NIFTY', expiryDate: '2026-12-02' })
  assert.equal(ok.value.wordLimit, 100)
  assert.equal('optionChain' in validateChatRequest({ message: 'q' }).value, false)
  assert.match(validateChatRequest({ message: 'q', optionChain: { symbol: 'NI FTY', expiryDate: '2026-12-02' } }).error, /symbol/)
  assert.match(validateChatRequest({ message: 'q', optionChain: { symbol: 'NIFTY', expiryDate: '02-12-2026' } }).error, /expiry/)
  assert.match(validateChatRequest({ message: 'q', optionChain: { symbol: 'NIFTY', expiryDate: '2026-13-45' } }).error, /expiry/)
  for (const bad of [5, 5000, 99.5, '100']) assert.match(validateChatRequest({ message: 'q', wordLimit: bad }).error, /Word limit/)
})

test('prompt + buildMessages: the option chain block and the word limit reach the model', () => {
  assert.doesNotMatch(systemPrompt({}), /word|option chain/i)
  const prompt = systemPrompt({ wordLimit: 120, hasOptionChain: true })
  assert.match(prompt, /within 120 words/)
  assert.match(prompt, /option chain data block/)
  const messages = buildMessages({ now: new Date(), parts: [], history: [], message: 'Q?', optionChain: 'OPTION CHAIN DATA (Groww) ...', wordLimit: 120 })
  assert.match(messages[0].content, /within 120 words/)
  assert.equal(messages[1].content, 'OPTION CHAIN DATA (Groww) ...')
  assert.match(messages.at(-1).content, /^Q\?/)
})

const chain = { underlying_ltp: 24510, filtered_strikes: { 24500: { CE: { ltp: 120, open_interest: 1100, greeks: { iv: 12, delta: 0.52, gamma: 0.001 } }, PE: { ltp: 95, open_interest: 900, greeks: { iv: 13, delta: -0.48, gamma: 0.001 } } } } }

test('buildOptionChainContext: fetches with the stored token, adds the change since the stored snapshot', async () => {
  let call
  const snapshot = { tick: 1795759200, expiry: '2026-12-02', underlyingLtp: 24480, strikes: [{ strike: 24500, ce: { oi: 1000, ltp: 110 }, pe: { oi: 900, ltp: 100 } }] }
  const text = await buildOptionChainContext({ symbol: 'NIFTY', expiryDate: '2026-12-02' }, { getToken: async () => 'tok', fetchChain: async (a) => { call = a; return chain }, loadSnapshot: async () => snapshot }, new Date('2026-11-27T10:00:00Z'))
  assert.deepEqual([call.exchange, call.underlying_symbol, call.expiry_date, call.groww_token], ['NSE', 'NIFTY', '2026-12-02', 'tok'])
  assert.match(text, /NIFTY, expiry 2026-12-02, fetched 2026-11-27T10:00:00.000Z/)
  assert.match(text, /"strike":24500/)
  assert.match(text, /CHANGE SINCE THE STORED SNAPSHOT/)
  assert.match(text, /"metric":"OI","prev":1000,"curr":1100,"diff":100/)
  assert.doesNotMatch(text, /"side":"PE","metric":"OI","prev":900,"curr":900/) // unchanged values are left out
})

test('buildOptionChainContext: no snapshot, a snapshot of another expiry, or a failing lookup -> single point in time', async () => {
  const base = { getToken: async () => 'tok', fetchChain: async () => chain }
  for (const loadSnapshot of [async () => null, async () => ({ tick: 1, expiry: '2026-12-09', underlyingLtp: 1, strikes: [] }), async () => { throw new Error('index missing') }]) {
    const text = await buildOptionChainContext({ symbol: 'NIFTY', expiryDate: '2026-12-02' }, { ...base, loadSnapshot })
    assert.match(text, /only this single point in time/)
    assert.doesNotMatch(text, /CHANGE SINCE/)
  }
})

test('buildOptionChainContext: clear errors for a missing or expired token, no chain, and Groww failures', async () => {
  const ctx = { symbol: 'NIFTY', expiryDate: '2026-12-02' }
  const failing = (status_code, message = 'x') => async () => { throw Object.assign(new Error('f'), { details: { status_code, message } }) }
  await assert.rejects(buildOptionChainContext(ctx, { getToken: async () => null }), (e) => e instanceof ChatError && e.status === 401 && /Greek Analysis/.test(e.message))
  await assert.rejects(buildOptionChainContext(ctx, { getToken: async () => { throw new Error('boom') } }), (e) => e.status === 401)
  await assert.rejects(buildOptionChainContext(ctx, { getToken: async () => 't', fetchChain: failing(401) }), (e) => e.status === 401 && /expired/.test(e.message))
  await assert.rejects(buildOptionChainContext(ctx, { getToken: async () => 't', fetchChain: failing(404) }), (e) => e.status === 400 && /no option chain/.test(e.message))
  await assert.rejects(buildOptionChainContext(ctx, { getToken: async () => 't', fetchChain: failing(500, 'upstream') }), (e) => e.status === 502 && /upstream/.test(e.message))
})

test('runChat: the option chain block is fetched only when asked for, and only after the cheap checks pass', async () => {
  let fetched = 0
  const { deps } = fakeDeps()
  const withOc = { ...deps, optionChain: async (ctx) => { fetched++; return `BLOCK for ${ctx.symbol}` } }
  await runChat({ message: 'plain question' }, withOc)
  assert.equal(fetched, 0)
  await assert.rejects(runChat({ conversationId: 'convmissing001', message: 'x', optionChain: { symbol: 'NIFTY', expiryDate: '2026-12-02' } }, withOc), (e) => e.status === 404)
  assert.equal(fetched, 0)
  let sent
  const spy = { ...withOc, chat: async (messages, options) => { sent = messages; return deps.chat(messages, options) } }
  await runChat({ message: 'Is Call OI building?', optionChain: { symbol: 'NIFTY', expiryDate: '2026-12-02' }, wordLimit: 80 }, spy)
  assert.equal(fetched, 1)
  assert.ok(sent.some((m) => m.content === 'BLOCK for NIFTY'))
  assert.match(sent[0].content, /within 80 words/)
})

test('option chain context validation: a saved snapshot (date + time) and a compare-with interval', () => {
  const now = new Date('2026-11-27T10:00:00Z')
  const ok = validateChatContext({ optionChain: { symbol: 'nifty', asOf: { date: '2026-11-24', time: '10:15' }, compareWith: '1h' } }, now)
  assert.deepEqual(ok.value.optionChain, { symbol: 'NIFTY', asOf: { date: '2026-11-24', time: '10:15' }, compareWith: '1h' })
  assert.equal(SNAPSHOT_TIMES.length, 26)
  assert.deepEqual([SNAPSHOT_TIMES[0], SNAPSHOT_TIMES[1], SNAPSHOT_TIMES.at(-1)], ['09:15', '09:30', '15:30'])
  // No expiry is needed for a saved snapshot, and a live request still needs one.
  assert.equal('expiryDate' in ok.value.optionChain, false)
  assert.match(validateChatContext({ optionChain: { symbol: 'NIFTY' } }, now).error, /expiry/)
  assert.deepEqual(validateChatContext({ optionChain: { symbol: 'NIFTY', expiryDate: '2026-12-01', compareWith: '15m' } }, now).value.optionChain, { symbol: 'NIFTY', expiryDate: '2026-12-01', compareWith: '15m' })
  const bad = (asOf, pattern) => assert.match(validateChatContext({ optionChain: { symbol: 'NIFTY', asOf } }, now).error, pattern)
  bad({ date: '2026-11-31', time: '10:15' }, /date/)
  bad({ date: '2026-11-24', time: '10:20' }, /time/)
  bad({ date: '2026-11-24', time: '9:15' }, /time/)
  bad({ date: '2026-11-28', time: '10:15' }, /weekdays/) // a Saturday
  bad({ date: '2026-11-30', time: '10:15' }, /future/)
  assert.match(validateChatContext({ optionChain: { symbol: 'NIFTY', asOf: { date: '2026-11-27', time: '15:30' } } }, new Date('2026-11-27T09:50:00Z')).error, /future/) // today, 15:20 IST: 15:30 has not happened yet
  assert.ok(validateChatContext({ optionChain: { symbol: 'NIFTY', asOf: { date: '2026-11-27', time: '15:30' } } }, now).value, 'at 15:30 IST it has')
  assert.match(validateChatContext({ optionChain: { symbol: 'NIFTY', asOf: { date: '2026-11-24', time: '10:15' }, compareWith: '2d' } }, now).error, /Compare with/)
})

test('buildOptionChainContext: a saved snapshot needs no token, is read at its exact tick and compared with the chosen earlier one', async () => {
  const tick = istEpoch('2026-11-24', '10:15')
  const mk = (t, oi, ltp) => ({ tick: t, expiry: '2026-12-01', underlyingLtp: ltp, strikes: [{ strike: 24500, ce: { oi, ltp: 100 }, pe: { oi: 900, ltp: 90 } }] })
  const calls = []
  const store = { [tick]: mk(tick, 1300, 24510), [tick - 3600]: mk(tick - 3600, 1000, 24400) }
  const deps = { getToken: async () => { throw new Error('the token must not be read') }, fetchChain: async () => { throw new Error('Groww must not be called') }, loadSnapshot: async (symbol, limit, maxAge) => { calls.push([symbol, limit, maxAge]); return store[limit] ?? null } }
  const text = await buildOptionChainContext({ symbol: 'NIFTY', asOf: { date: '2026-11-24', time: '10:15' }, compareWith: '1h' }, deps, new Date('2026-11-27T10:00:00Z'))
  assert.deepEqual(calls, [['NIFTY', tick, 0], ['NIFTY', tick - 3600, 1800]])
  assert.match(text, /saved 15-minute snapshot of 2026-11-24 10:15 IST, not live/)
  assert.match(text, /expiry 2026-12-01/)
  assert.match(text, /Volume is not stored/)
  assert.match(text, /about 1 hour earlier/)
  assert.match(text, /SNAPSHOT of 2026-11-24 09:15 IST/, 'times are given in IST, not UTC')
  assert.match(text, /"metric":"OI","prev":1000,"curr":1300,"diff":300/)
  // Without compareWith a saved snapshot is compared with the one 15 minutes before; a missing one gives a single point in time.
  const lone = await buildOptionChainContext({ symbol: 'NIFTY', asOf: { date: '2026-11-24', time: '10:15' } }, { ...deps, loadSnapshot: async (s, limit) => (limit === tick ? store[tick] : null) })
  assert.match(lone, /about 15 minutes before is stored, so only this single point in time/)
  // A 1-day comparison allows for a weekend or a holiday.
  calls.length = 0
  await buildOptionChainContext({ symbol: 'NIFTY', asOf: { date: '2026-11-24', time: '10:15' }, compareWith: '1d' }, deps)
  assert.deepEqual(calls[1], ['NIFTY', tick - 86400, 4 * 86400])
})

test('buildOptionChainContext: no saved snapshot at that time -> a clear 400; a failing read -> 502; another expiry is not diffed', async () => {
  const ctx = { symbol: 'NIFTY', asOf: { date: '2026-11-24', time: '10:15' } }
  await assert.rejects(buildOptionChainContext(ctx, { loadSnapshot: async () => null }), (e) => e instanceof ChatError && e.status === 400 && /No saved option chain snapshot for NIFTY at 2026-11-24 10:15 IST/.test(e.message))
  await assert.rejects(buildOptionChainContext(ctx, { loadSnapshot: async () => ({ tick: 1, expiry: '2026-12-01', underlyingLtp: 1, strikes: [] }) }), (e) => e.status === 400) // not the exact tick
  await assert.rejects(buildOptionChainContext(ctx, { loadSnapshot: async () => { throw new Error('index missing') } }), (e) => e.status === 502)
  const tick = istEpoch('2026-11-24', '10:15')
  const text = await buildOptionChainContext(ctx, { loadSnapshot: async (s, limit) => (limit === tick ? { tick, expiry: '2026-12-01', underlyingLtp: 1, strikes: [] } : { tick: limit, expiry: '2026-11-24', underlyingLtp: 1, strikes: [] }) })
  assert.doesNotMatch(text, /CHANGE SINCE/)
})

test('buildOptionChainContext: live with compareWith counts back from the newest stored snapshot, so it works after hours', async () => {
  const closeTick = istEpoch('2026-11-27', '15:30')
  const now = new Date('2026-11-27T12:21:00Z') // 17:51 IST, market closed
  const nowTick = Math.floor(now.getTime() / 1000) - (Math.floor(now.getTime() / 1000) % 900)
  const calls = []
  const snap = (tick) => ({ tick, expiry: '2026-12-01', underlyingLtp: 24480, strikes: [{ strike: 24500, ce: { oi: 1000, ltp: 110 }, pe: { oi: 900, ltp: 100 } }] })
  const loadSnapshot = async (symbol, limit, maxAge) => { calls.push([limit, maxAge]); return limit >= closeTick && limit < closeTick + 900 ? snap(closeTick) : limit === closeTick - 3600 ? snap(limit) : limit === nowTick ? snap(closeTick) : null }
  const deps = { getToken: async () => 't', fetchChain: async () => chain, loadSnapshot }
  const text = await buildOptionChainContext({ symbol: 'NIFTY', expiryDate: '2026-12-01', compareWith: '1h' }, deps, now)
  assert.deepEqual(calls, [[nowTick, 4 * 86400], [closeTick - 3600, 1800]])
  assert.match(text, /SNAPSHOT of 2026-11-27 14:30 IST/)
  assert.match(text, /about 1 hour earlier/)
  // Nothing stored at all: a single point in time, not an error.
  const none = await buildOptionChainContext({ symbol: 'NIFTY', expiryDate: '2026-12-01', compareWith: '1h' }, { ...deps, loadSnapshot: async () => null }, now)
  assert.match(none, /about 1 hour before is stored, so only this single point in time/)
  // No compareWith: the latest stored snapshot, as before.
  calls.length = 0
  await buildOptionChainContext({ symbol: 'NIFTY', expiryDate: '2026-12-01' }, deps, now)
  assert.deepEqual(calls, [[nowTick, 4 * 3600]])
})

const SJ = await import('xlsx')
const bytesOf = (bookType) => {
  const wb = SJ.utils.book_new()
  SJ.utils.book_append_sheet(wb, SJ.utils.aoa_to_sheet([['Participant', 'Long', 'Short'], ['FII', 150000, 90000], ['Pro', 40000, 30000]]), 'OI')
  SJ.utils.book_append_sheet(wb, SJ.utils.aoa_to_sheet([['Symbol', 'Price'], ['NIFTY', 25851.5]]), 'Prices')
  return Buffer.from(SJ.write(wb, { type: 'buffer', bookType }))
}

test('sheetToText: .xlsx, .xlsm, .xls, .xlsb and .ods all become the same tables, one block per sheet', async () => {
  for (const [ext, bookType] of [['xlsx', 'xlsx'], ['xlsm', 'xlsm'], ['xls', 'biff8'], ['xlsb', 'xlsb'], ['ods', 'ods']]) {
    const { text, truncated } = await sheetToText({ fileName: `oi.${ext}` }, bytesOf(bookType))
    assert.equal(truncated, false, ext)
    assert.match(text, /### OI rows 2-3/, ext)
    assert.match(text, /\| FII \| 150000 \| 90000 \|/, ext)
    assert.match(text, /### Prices rows 2-2/, ext)
    assert.match(text, /\| NIFTY \| 25851\.5 \|/, ext)
  }
})

test('sheetToText: CSV in UTF-16 and Windows-1252 is decoded, not garbled', async () => {
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Name\tAmount\nCafé\t₹100\n', 'utf16le')])
  assert.match((await sheetToText({ fileName: 'a.csv' }, utf16)).text, /Café\t₹100/)
  assert.match((await sheetToText({ fileName: 'b.csv' }, Buffer.from('Name,City\nJosé,Zürich\n', 'latin1'))).text, /José,Zürich/)
  assert.match((await sheetToText({ fileName: 'c.csv' }, Buffer.from('﻿a,b\n1,2\n'))).text, /^a,b/)
})

test('sheetToText: JSON - an array of records is a table, an object of arrays is one table each, anything else is pretty-printed', async () => {
  const records = await sheetToText({ fileName: 'r.json' }, Buffer.from(JSON.stringify([{ symbol: 'NIFTY', oi: 10 }, { symbol: 'BANKNIFTY', oi: 20, tags: ['a', 'b'] }])))
  assert.match(records.text, /### JSON rows 2-3/)
  assert.match(records.text, /\| symbol \| oi \| tags \|/)
  assert.match(records.text, /\| BANKNIFTY \| 20 \| \["a","b"\] \|/)
  const nested = await sheetToText({ fileName: 'n.json' }, Buffer.from(JSON.stringify({ asOf: '2026-11-27', calls: [{ k: 1 }], puts: [{ k: 2 }] })))
  assert.match(nested.text, /### calls rows 2-2/)
  assert.match(nested.text, /### puts rows 2-2/)
  assert.match(nested.text, /### Other fields\n\{\n  "asOf": "2026-11-27"/)
  const plain = await sheetToText({ fileName: 'p.json' }, Buffer.from('{"a":{"b":[1,2]},"c":"x"}'))
  assert.match(plain.text, /^\{\n {2}"a": \{/)
  assert.equal((await sheetToText({ fileName: 'e.json' }, Buffer.from('[]'))).text, '[]')
  const long = await sheetToText({ fileName: 'l.json' }, Buffer.from(JSON.stringify({ k: Array.from({ length: 500 }, (_, i) => `value-${i}`) })), { maxChars: 600 })
  assert.equal(long.truncated, true)
  assert.match(long.text, /\[truncated - showing the first \d+ of \d+ lines/)
})

test('option chain: compareWith "none" is valid and means no comparison - no snapshot is looked up, saved or live', async () => {
  const now = new Date('2026-11-27T10:00:00Z')
  assert.equal(validateChatContext({ optionChain: { symbol: 'NIFTY', expiryDate: '2026-12-01', compareWith: 'none' } }, now).value.optionChain.compareWith, 'none')
  assert.equal(validateChatContext({ optionChain: { symbol: 'NIFTY', asOf: { date: '2026-11-24', time: '10:15' }, compareWith: 'none' } }, now).value.optionChain.compareWith, 'none')
  assert.match(validateChatContext({ optionChain: { symbol: 'NIFTY', expiryDate: '2026-12-01', compareWith: 'nope' } }, now).error, /none/)
  const tick = istEpoch('2026-11-24', '10:15')
  const calls = []
  const snap = { tick, expiry: '2026-12-01', underlyingLtp: 24510, strikes: [{ strike: 24500, ce: { oi: 1300, ltp: 100 }, pe: { oi: 900, ltp: 90 } }] }
  const loadSnapshot = async (symbol, limit, maxAge) => { calls.push([limit, maxAge]); return limit === tick ? snap : { ...snap, tick: limit } }
  const saved = await buildOptionChainContext({ symbol: 'NIFTY', asOf: { date: '2026-11-24', time: '10:15' }, compareWith: 'none' }, { loadSnapshot }, now)
  assert.deepEqual(calls, [[tick, 0]], 'only the chosen snapshot is read')
  assert.match(saved, /No comparison with an earlier snapshot was requested, so only this single point in time/)
  assert.doesNotMatch(saved, /CHANGE SINCE/)
  calls.length = 0
  const live = await buildOptionChainContext({ symbol: 'NIFTY', expiryDate: '2026-12-01', compareWith: 'none' }, { getToken: async () => 't', fetchChain: async () => chain, loadSnapshot }, now)
  assert.deepEqual(calls, [])
  assert.match(live, /No comparison with an earlier snapshot was requested/)
  assert.doesNotMatch(live, /CHANGE SINCE|is stored/)
})

// ---- where an answer comes from: option chain only / the same data in a follow-up / files ----

const OC = { symbol: 'NIFTY', asOf: { date: '2026-11-24', time: '10:15' } }
const ocDeps = (over = {}) => {
  const fetched = []
  const { deps, state } = fakeDeps({ optionChain: async (ctx) => { fetched.push(ctx); return `OPTION CHAIN DATA block for ${ctx.symbol} #${fetched.length}` }, ...over })
  return { deps, state, fetched }
}
const lastCall = (state) => state.calls.at(-1)
const filePartsOf = (messages) => messages.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((p) => p.type === 'file') : []))

test('conversation references ("previous message", "latest answer") do not pull stored files in; document wording still does', () => {
  const pick = (q) => chooseFilesByVersion(q, versions, { now: NOW })
  for (const q of ['Please explain the previous message in more detail', 'explain the latest answer', 'what did you mean in your last reply?', 'expand on the above explanation', 'Explain more about the previous response']) {
    assert.deepEqual(pick(q), { fileIds: [], note: null, roles: {} }, q)
  }
  assert.deepEqual(pick('Compare the current and previous FII report').fileIds, ['fileversion02', 'fileversion03'])
  assert.deepEqual(pick('Compare the previous FII report with your previous answer').fileIds, ['fileversion02', 'fileversion03'])
  assert.deepEqual(pick('Summarise the latest report').fileIds, ['fileversion03'])
})

test('runChat: an Option Chain question uses only the option chain - not the conversation files, a typed date, or "previous"', async () => {
  const { deps, state, fetched } = ocDeps()
  await runChat({ message: 'first, about a file', fileIds: ['fileaaaaaaaa2'] }, deps) // the conversation now has a file
  const r = await runChat({ conversationId: 'convaaaaaaaa1', message: 'On 10 Nov 2025, was the previous Call OI added?', optionChain: OC }, deps)
  const sent = lastCall(state)
  assert.equal(fetched.length, 1)
  assert.deepEqual(filePartsOf(sent), [], 'no file is sent')
  assert.ok(sent.some((m) => m.role === 'user' && /^OPTION CHAIN DATA block for NIFTY #1/.test(m.content)))
  assert.doesNotMatch(sent.at(-1).content, /No file is attached|no stored file|Only one version/)
  assert.doesNotMatch(sent[0].content, /attached files/)
  assert.match(sent[0].content, /option chain data block/)
  assert.deepEqual(r.files, [])
  assert.deepEqual(r.newlyAttached, [])
  assert.deepEqual(r.optionChain, { ...OC, carriedOver: false })
  assert.deepEqual(state.conversations.get('convaaaaaaaa1').fileIds, ['fileaaaaaaaa2'], "the conversation's files are untouched")
})

test('runChat: the option chain data is saved with the question, and a follow-up uses the SAME data without a new fetch', async () => {
  const { deps, state, fetched } = ocDeps()
  await runChat({ message: 'Is Call OI being added?', optionChain: OC }, deps)
  const saved = state.messages.get('convaaaaaaaa1')[0]
  assert.deepEqual(saved.optionChain, OC)
  assert.match(saved.optionChainBlock, /block for NIFTY #1/)
  assert.equal('optionChain' in state.messages.get('convaaaaaaaa1')[1], false, 'only the question record carries it')
  const follow = await runChat({ conversationId: 'convaaaaaaaa1', message: 'Please explain the previous message in more detail' }, deps)
  assert.equal(fetched.length, 1, 'no second fetch')
  const sent = lastCall(state)
  assert.ok(sent.some((m) => m.role === 'user' && /block for NIFTY #1/.test(m.content)), 'the same block is sent again')
  assert.ok(sent.some((m) => m.role === 'assistant'), 'and the earlier answer')
  assert.deepEqual(filePartsOf(sent), [])
  assert.doesNotMatch(sent.at(-1).content, /No file|attach|Only one version/)
  assert.deepEqual(follow.optionChain, { ...OC, carriedOver: true })
  // The follow-up keeps the data for the next follow-up too.
  await runChat({ conversationId: 'convaaaaaaaa1', message: 'and why?' }, deps)
  assert.equal(fetched.length, 1)
  assert.ok(lastCall(state).some((m) => m.role === 'user' && /block for NIFTY #1/.test(m.content)))
})

test('runChat: a new Option Chain question replaces the data; a file question after one is a files turn', async () => {
  const { deps, state, fetched } = ocDeps()
  await runChat({ message: 'q1', optionChain: OC }, deps)
  await runChat({ conversationId: 'convaaaaaaaa1', message: 'q2', optionChain: { ...OC, symbol: 'BANKNIFTY' } }, deps)
  assert.equal(fetched.length, 2)
  assert.ok(lastCall(state).some((m) => /block for BANKNIFTY #2/.test(String(m.content))))
  assert.ok(!lastCall(state).some((m) => /block for NIFTY #1/.test(String(m.content))), 'only the new block')
  // A report question with a file, then a follow-up: files, and no option chain block any more.
  await runChat({ conversationId: 'convaaaaaaaa1', message: 'What was the net position?', fileIds: ['fileaaaaaaaa2'] }, deps)
  let sent = lastCall(state)
  assert.equal(filePartsOf(sent).length, 1)
  assert.ok(!sent.some((m) => /OPTION CHAIN DATA/.test(String(m.content))))
  await runChat({ conversationId: 'convaaaaaaaa1', message: 'explain that again' }, deps)
  sent = lastCall(state)
  assert.equal(filePartsOf(sent).length, 1)
  assert.ok(!sent.some((m) => /OPTION CHAIN DATA/.test(String(m.content))))
  assert.equal(fetched.length, 2)
})

test('runChat: a follow-up that names a stored report date, or attaches a file, is a files turn even after an option chain answer', async () => {
  const { deps, state, fetched } = ocDeps()
  await runChat({ message: 'q1', optionChain: OC }, deps)
  const byDate = await runChat({ conversationId: 'convaaaaaaaa1', message: 'And compare with 10 Nov 2025' }, deps)
  assert.deepEqual(byDate.files.map((f) => f.id), ['fileaaaaaaaa1'])
  assert.ok(!lastCall(state).some((m) => /OPTION CHAIN DATA/.test(String(m.content))))
  const { deps: d2, state: s2 } = ocDeps()
  await runChat({ message: 'q1', optionChain: OC }, d2)
  await runChat({ conversationId: 'convaaaaaaaa1', message: 'what about this file?', fileIds: ['fileaaaaaaaa2'] }, d2)
  assert.equal(filePartsOf(lastCall(s2)).length, 1)
  assert.ok(!lastCall(s2).some((m) => /OPTION CHAIN DATA/.test(String(m.content))))
  assert.equal(fetched.length, 1)
})

test('runChat: files attached to the Option Chain request itself are used with the option chain; the model is told about both', async () => {
  const { deps, state } = ocDeps()
  const r = await runChat({ message: 'Does the option chain agree with this report?', optionChain: OC, fileIds: ['fileaaaaaaaa2'] }, deps)
  const sent = lastCall(state)
  assert.equal(filePartsOf(sent).length, 1)
  assert.ok(sent.some((m) => /OPTION CHAIN DATA/.test(String(m.content))))
  assert.match(sent[0].content, /attached files/)
  assert.match(sent[0].content, /option chain data block/)
  assert.deepEqual(r.files.map((f) => f.id), ['fileaaaaaaaa2'])
  assert.deepEqual(state.conversations.get('convaaaaaaaa1').fileIds, ['fileaaaaaaaa2'])
})

test('buildMessages / prompt: the "attach a file" nudge is only for a first question with nothing to work from', () => {
  const first = buildMessages({ now: NOW, parts: [], history: [], message: 'hi' })
  assert.match(first.at(-1).content, /No file is attached to this conversation yet/)
  const follow = buildMessages({ now: NOW, parts: [], history: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }], message: 'explain' })
  assert.doesNotMatch(follow.at(-1).content, /attach/)
  assert.match(follow.at(-1).content, /answer from the conversation/)
  assert.match(follow[0].content, /No file or option chain data comes with this question/)
  const files = systemPrompt({ hasFiles: true })
  assert.match(files, /The user has attached files/)
  assert.doesNotMatch(files, /option chain/i)
  const ocOnly = systemPrompt({ hasFiles: false, hasOptionChain: true })
  assert.doesNotMatch(ocOnly, /attached files|report date|version n of N/)
  assert.match(ocOnly, /Answer ONLY from the option chain data block and the conversation/)
})
