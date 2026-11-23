/**
 * Chat with the stored files. One question in, one answer out - no search, no tools:
 *   conversation id + file ids -> load the files from Firestore -> send files + question to the model.
 *
 * Which files: the ones attached to the conversation, any the user just attached, and any stored
 * file whose report date the question mentions ("compare with 14 Nov", "between 10 and 14 Nov",
 * "the latest report"). Pure helpers are exported for tests; runChat takes every outside effect as `deps`.
 */

import { extractDateFilter } from './dateFilter.js'
import { systemPrompt } from './prompts.js'
import { parseXlsx, parseCsvBuffer } from '../ingest/parseSheet.js'

export const MAX_FILES_PER_REQUEST = 5
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024
const HISTORY_MESSAGES = 10
// ~85k tokens at worst: numbers tokenize at roughly 1.7 characters per token, and every follow-up resends the file.
export const MAX_SHEET_CHARS = 150000

export class ChatError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/** Stored files whose report date the question mentions -> { fileIds, note }. `note` goes to the model when a date has no file. */
export function chooseFilesByDate(message, library, { now = new Date() } = {}) {
  const filter = extractDateFilter(message, { now })
  const dated = library.filter((f) => f.reportDate)
  const available = [...new Set(dated.map((f) => f.reportDate))].sort().reverse()
  const stored = `Stored report dates: ${available.slice(0, 15).join(', ') || 'none'}.`
  let matched = []
  let note = null
  if (filter.dates.length) {
    const missing = []
    for (const date of filter.dates) {
      const found = dated.filter((f) => f.reportDate === date)
      if (found.length) matched.push(...found)
      else missing.push(date)
    }
    if (missing.length) note = `The user mentioned report date${missing.length > 1 ? 's' : ''} ${missing.join(', ')}, but no stored file has ${missing.length > 1 ? 'those dates' : 'that date'}. ${stored} Tell the user; do not guess.`
  } else if (filter.range) {
    matched = dated.filter((f) => f.reportDate >= filter.range.from && f.reportDate <= filter.range.to)
    if (!matched.length) note = `The user mentioned report dates ${filter.range.from} to ${filter.range.to}, but no stored file falls in that range. ${stored} Tell the user; do not guess.`
  } else if (filter.latest && /\b(latest|newest|most recent)\b/i.test(message)) {
    const newest = [...dated].sort((a, b) => b.reportDate.localeCompare(a.reportDate))[0]
    if (newest) matched = [newest]
    else note = 'The user asked for the latest report, but no stored file has a report date. Tell the user.'
  }
  matched = [...matched].sort((a, b) => a.reportDate.localeCompare(b.reportDate)).slice(-MAX_FILES_PER_REQUEST)
  return { fileIds: matched.map((f) => f.id), note }
}

/** Keeps the most recently attached files within the caps; returns { included (original order), dropped }. */
export function selectFilesForRequest(files, { maxFiles = MAX_FILES_PER_REQUEST, maxBytes = MAX_TOTAL_BYTES } = {}) {
  const included = []
  let bytes = 0
  for (let i = files.length - 1; i >= 0; i -= 1) {
    if (included.length < maxFiles && bytes + files[i].sizeBytes <= maxBytes) {
      included.unshift(files[i])
      bytes += files[i].sizeBytes
    }
  }
  const keep = new Set(included.map((f) => f.id))
  return { included, dropped: files.filter((f) => !keep.has(f.id)) }
}

const cutAtLine = (text, max) => {
  const head = text.slice(0, max)
  return head.slice(0, Math.max(head.lastIndexOf('\n'), 0) || max)
}

/**
 * An Excel / CSV file as text for the model -> { text, truncated }. CSV is sent as it is (compact);
 * Excel as markdown tables, one block per sheet / 40-row range. Long files are cut at the cap, on a line
 * or block boundary, with a note saying how much is shown.
 */
export async function sheetToText(file, buffer, { maxChars = MAX_SHEET_CHARS } = {}) {
  if (/\.csv$/i.test(file.fileName)) {
    const raw = buffer.toString('utf8').replace(/^\uFEFF/, '')
    if (raw.length <= maxChars) return { text: raw, truncated: false }
    const text = cutAtLine(raw, maxChars)
    return { text: `${text}\n[truncated - showing the first ${text.split('\n').length} of ${raw.split('\n').length} lines; the rest of the file is not included]`, truncated: true }
  }
  const { pages } = await parseXlsx(buffer)
  const blocks = pages.map((p) => `### ${p.label}\n${p.text}`)
  let text = ''
  let shown = 0
  for (const block of blocks) {
    if (text.length + block.length + 2 > maxChars && shown > 0) break
    text += (shown ? '\n\n' : '') + block
    shown += 1
  }
  if (text.length > maxChars) text = cutAtLine(text, maxChars)
  const truncated = shown < blocks.length || text.length < blocks[0].length
  return { text: truncated ? `${text}\n[truncated - showing ${shown} of ${blocks.length} sections; the rest of the file is not included]` : text, truncated }
}

/** Message content parts for the files: a label line each, then the PDF itself or the sheet as text. -> { parts, truncated: files that were cut } */
export async function buildFileParts(files, { getBytes }) {
  const parts = []
  const truncated = []
  for (const [i, file] of files.entries()) {
    parts.push({ type: 'text', text: `File ${i + 1}: "${file.title}" (${file.fileName}); report date: ${file.reportDate || 'unknown'}` })
    const bytes = await getBytes(file)
    if (file.kind === 'pdf') parts.push({ type: 'file', file: { filename: file.fileName, file_data: `data:application/pdf;base64,${bytes.toString('base64')}` } })
    else {
      const sheet = await sheetToText(file, bytes)
      parts.push({ type: 'text', text: sheet.text })
      if (sheet.truncated) truncated.push(file)
    }
  }
  return { parts, truncated }
}

/** system -> files -> earlier messages -> the new question (with any note appended). The files come first so the prompt prefix stays stable between turns. */
export function buildMessages({ now, parts, history = [], message, note }) {
  const messages = [{ role: 'system', content: systemPrompt({ now }) }]
  if (parts.length) messages.push({ role: 'user', content: [{ type: 'text', text: 'These are the files attached to this conversation:' }, ...parts] })
  for (const m of history.slice(-HISTORY_MESSAGES)) if ((m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content) messages.push({ role: m.role, content: m.content.slice(0, 6000) })
  const notes = [note, parts.length ? null : 'No file is attached to this conversation yet. If the question needs a file, ask the user to attach one with the paperclip.'].filter(Boolean)
  messages.push({ role: 'user', content: notes.length ? `${message}\n\n[Note for the assistant, not written by the user: ${notes.join(' ')}]` : message })
  return messages
}

const brief = ({ id, title, reportDate, kind, sizeBytes }) => ({ id, title, reportDate: reportDate ?? null, kind, sizeBytes })

/**
 * deps: conversations { create, get, setFiles, listMessages, appendMessages },
 *       files { list, getBytes }, chat(messages, options) -> { message: { content }, usage }, logUsage?, now?
 */
export async function runChat({ conversationId, message, fileIds = [] }, deps) {
  const now = deps.now ?? new Date()
  let conversation = null
  if (conversationId) {
    conversation = await deps.conversations.get(conversationId)
    if (!conversation) throw new ChatError(404, 'Conversation not found')
  }
  const library = await deps.files.list()
  const byId = new Map(library.map((f) => [f.id, f]))
  if (fileIds.some((id) => !byId.has(id))) throw new ChatError(400, 'One of the attached files no longer exists')

  const auto = chooseFilesByDate(message, library, { now })
  const previous = (conversation?.fileIds ?? []).filter((id) => byId.has(id))
  const thisTurn = [...new Set([...fileIds, ...auto.fileIds])]
  const attached = [...new Set([...previous, ...thisTurn])]
  const { included, dropped } = selectFilesForRequest(attached.map((id) => byId.get(id)))
  const droppedNote = dropped.length ? `These attached files were left out because of size limits: ${dropped.map((f) => `"${f.title}"`).join(', ')}. Tell the user.` : null

  const history = conversation ? await deps.conversations.listMessages(conversation.id) : []
  const { parts, truncated } = await buildFileParts(included, { getBytes: deps.files.getBytes })
  const truncatedNote = truncated.length ? `These files are too long and only the first part was included: ${truncated.map((f) => `"${f.title}"`).join(', ')}. Say so if the answer might depend on the rest.` : null
  const messages = buildMessages({ now, parts, history, message, note: [auto.note, droppedNote, truncatedNote].filter(Boolean).join(' ') || null })

  const reply = await deps.chat(messages, { maxTokens: 1500, temperature: 0.2 })
  const answer = String(reply?.message?.content ?? '').trim()
  if (!answer) throw new ChatError(502, 'The model returned an empty answer')

  if (!conversation) conversation = await deps.conversations.create({ title: message.slice(0, 60) })
  if (attached.length !== (conversation.fileIds ?? []).length || attached.some((id) => !(conversation.fileIds ?? []).includes(id))) await deps.conversations.setFiles(conversation.id, attached)
  await deps.conversations.appendMessages(conversation.id, [
    { role: 'user', content: message, fileIds: thisTurn },
    { role: 'assistant', content: answer, usage: reply.usage ?? null },
  ])
  await deps.logUsage?.({ feature: 'file_chat', usage: reply.usage, metadata: { conversationId: conversation.id, files: included.length } })

  const newly = attached.filter((id) => !previous.includes(id))
  return {
    conversationId: conversation.id,
    answer,
    files: included.map(brief),
    newlyAttached: newly.map((id) => ({ ...brief(byId.get(id)), auto: !fileIds.includes(id) })),
    dropped: dropped.map(brief),
    truncated: truncated.map(brief),
    usage: reply.usage ?? null,
  }
}
