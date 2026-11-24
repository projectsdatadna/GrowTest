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
import { groupFamilies, versionInfo, currentAndPrevious, effectiveDate, istDay } from './fileFamily.js'

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
  const dated = library.filter((f) => effectiveDate(f))
  const available = [...new Set(dated.map((f) => effectiveDate(f)))].sort().reverse()
  const stored = `Stored report dates: ${available.slice(0, 15).join(', ') || 'none'}.`
  let matched = []
  let note = null
  if (filter.dates.length) {
    const missing = []
    for (const date of filter.dates) {
      const found = dated.filter((f) => effectiveDate(f) === date)
      if (found.length) matched.push(...found)
      else missing.push(date)
    }
    if (missing.length) note = `The user mentioned report date${missing.length > 1 ? 's' : ''} ${missing.join(', ')}, but no stored file has ${missing.length > 1 ? 'those dates' : 'that date'}. ${stored} Tell the user; do not guess.`
  } else if (filter.range) {
    matched = dated.filter((f) => effectiveDate(f) >= filter.range.from && effectiveDate(f) <= filter.range.to)
    if (!matched.length) note = `The user mentioned report dates ${filter.range.from} to ${filter.range.to}, but no stored file falls in that range. ${stored} Tell the user; do not guess.`
  }
  matched = [...matched].sort((a, b) => effectiveDate(a).localeCompare(effectiveDate(b))).slice(-MAX_FILES_PER_REQUEST)
  return { fileIds: matched.map((f) => f.id), note }
}

const PREVIOUS_RE = /\b(previous|prior|preceding)\b|\b(earlier|older)\s+(version|upload|report|file|copy|one|date|day)\b|\blast\s+(version|upload|time|report|file|copy)\b|\bbefore\s+(this|that|the\s+(latest|current|new))\b|\bsince\s+(the\s+)?(last|previous|earlier)\b/i
const CURRENT_RE = /\b(latest|newest|most recent)\b|\bcurrent\s+(version|upload|report|file|copy|one)\b|\bnew(ly)?\s+uploaded\b|\bjust\s+uploaded\b/i
// Words that say nothing about WHICH document is meant.
const GENERIC_WORDS = new Set(['report', 'reports', 'file', 'files', 'data', 'daily', 'copy', 'the', 'and', 'for', 'new', 'old', 'final'])

/**
 * "The current and the previous report", "what changed since the previous version", "the latest report":
 * picks the newest version of one document (and the one before it) -> { fileIds (oldest first), note, roles: {id: 'current'|'previous'} }.
 * Which document: the one whose name the question mentions, else the one(s) already in the conversation, else the newest upload.
 * Questions that name dates are left to chooseFilesByDate.
 */
export function chooseFilesByVersion(message, library, { conversationFiles = [], now = new Date() } = {}) {
  const wantsPrevious = PREVIOUS_RE.test(message)
  if (!wantsPrevious && !CURRENT_RE.test(message)) return { fileIds: [], note: null, roles: {} }
  const filter = extractDateFilter(message, { now })
  if (filter.dates.length || filter.range) return { fileIds: [], note: null, roles: {} }
  if (!library.length) return { fileIds: [], note: null, roles: {} }

  const families = groupFamilies(library)
  const words = new Set(String(message).toLowerCase().match(/[a-z0-9&]+/g) ?? [])
  // How well the question names a document: distinctive words matched, then any word matched ("report" too), then fewer words left over.
  const score = (key) => {
    const own = key.split(' ').filter((w) => w.length >= 2)
    const distinct = own.filter((w) => !GENERIC_WORDS.has(w) && words.has(w)).length
    const any = own.filter((w) => words.has(w)).length
    return distinct > 0 ? [distinct, any, -(own.length - any)] : [0, 0, 0]
  }
  const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
  const newestUpload = (key) => families.get(key).reduce((max, f) => (String(f.uploadedAt || '') > max ? String(f.uploadedAt || '') : max), '')
  const inConversation = new Set(conversationFiles.map((f) => [...families].find(([, files]) => files.some((x) => x.id === f.id))?.[0]).filter(Boolean))

  let keys = []
  const scored = [...families.keys()].map((k) => [k, score(k)])
  const best = scored.reduce((top, [, sc]) => (compare(sc, top) > 0 ? sc : top), [0, 0, 0])
  if (best[0] > 0) keys = scored.filter(([, sc]) => compare(sc, best) === 0).map(([k]) => k)
  if (keys.length > 1) {
    const narrowed = keys.filter((k) => inConversation.has(k))
    keys = narrowed.length ? narrowed : [keys.sort((a, b) => newestUpload(b).localeCompare(newestUpload(a)))[0]]
  }
  if (!keys.length) keys = [...inConversation]
  if (!keys.length) keys = [[...families.keys()].sort((a, b) => newestUpload(b).localeCompare(newestUpload(a)))[0]]

  const picked = []
  const roles = {}
  const notes = []
  for (const key of keys) {
    const { current, previous } = currentAndPrevious(families.get(key))
    if (previous && wantsPrevious) {
      picked.push(previous)
      roles[previous.id] = 'previous'
    }
    picked.push(current)
    roles[current.id] = 'current'
    if (wantsPrevious && !previous) notes.push(`Only one version of "${current.title}" is stored (report date ${effectiveDate(current)}), so there is no previous version to compare with. Tell the user to upload another version.`)
  }
  return { fileIds: picked.map((f) => f.id), note: notes.join(' ') || null, roles }
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
export async function buildFileParts(files, { getBytes, versions = new Map() }) {
  const parts = []
  const truncated = []
  for (const [i, file] of files.entries()) {
    const uploaded = istDay(file.uploadedAt)
    const version = versions.get(file.id)
    const label = `File ${i + 1}: "${file.title}" (${file.fileName}); report date: ${file.reportDate || 'unknown'}${uploaded ? `; uploaded: ${uploaded}` : ''}${version && version.of > 1 ? `; version ${version.n} of ${version.of} of this document` : ''}`
    parts.push({ type: 'text', text: label })
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

const brief = ({ id, title, reportDate, uploadedAt, kind, sizeBytes }) => ({ id, title, reportDate: reportDate ?? null, uploadedAt: uploadedAt ?? null, kind, sizeBytes })

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

  const previous = (conversation?.fileIds ?? []).filter((id) => byId.has(id))
  const byDate = chooseFilesByDate(message, library, { now })
  const byVersion = chooseFilesByVersion(message, library, { conversationFiles: [...previous, ...fileIds].map((id) => byId.get(id)), now })
  const auto = { fileIds: [...new Set([...byDate.fileIds, ...byVersion.fileIds])], note: [byDate.note, byVersion.note].filter(Boolean).join(' ') || null }
  const thisTurn = [...new Set([...fileIds, ...auto.fileIds])]
  const attached = [...new Set([...previous, ...thisTurn])]
  const { included, dropped } = selectFilesForRequest(attached.map((id) => byId.get(id)))
  const droppedNote = dropped.length ? `These attached files were left out because of size limits: ${dropped.map((f) => `"${f.title}"`).join(', ')}. Tell the user.` : null

  const history = conversation ? await deps.conversations.listMessages(conversation.id) : []
  const { parts, truncated } = await buildFileParts(included, { getBytes: deps.files.getBytes, versions: versionInfo(library) })
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
    newlyAttached: newly.map((id) => ({ ...brief(byId.get(id)), auto: !fileIds.includes(id), role: byVersion.roles[id] ?? null })),
    dropped: dropped.map(brief),
    truncated: truncated.map(brief),
    usage: reply.usage ?? null,
  }
}
