/**
 * Page-aware chunking for the document store. A chunk never crosses a page (so
 * every citation is "doc, date, page N"), paragraphs stay together, markdown
 * tables are split by rows with the header repeated, and when a page needs more
 * than one chunk the next one starts with a short overlap of the previous.
 * Pure - no I/O.
 */

const CHARS_PER_TOKEN = 4
export const approxTokens = (text) => Math.ceil(text.length / CHARS_PER_TOKEN)

const isTableLine = (line) => line.trim().startsWith('|')
const isHeading = (block) => {
  const text = block.trim()
  if (!text || text.includes('\n') || text.length > 80 || /[.:;,]$/.test(text)) return false
  if (text.startsWith('#')) return true
  const letters = text.replace(/[^A-Za-z]/g, '')
  return letters.length >= 4 && letters === letters.toUpperCase()
}

// Words of one over-long line, in windows of at most `max` characters.
function splitLine(line, max) {
  const parts = []
  let current = ''
  for (const word of line.split(/\s+/)) {
    if (word.length > max) {
      if (current) parts.push(current)
      for (let i = 0; i < word.length; i += max) parts.push(word.slice(i, i + max))
      current = ''
    } else if (current && current.length + word.length + 1 > max) {
      parts.push(current)
      current = word
    } else {
      current = current ? `${current} ${word}` : word
    }
  }
  if (current) parts.push(current)
  return parts
}

// One block longer than `max`: by lines (table rows keep their 2-line header).
function splitLong(block, max) {
  const lines = block.split('\n')
  const table = isTableLine(lines[0]) && lines.length > 2 && /^\|[\s:|-]+\|?$/.test(lines[1].trim())
  const header = table ? `${lines[0]}\n${lines[1]}` : ''
  const body = table ? lines.slice(2) : lines
  const parts = []
  let current = header
  for (const line of body) {
    for (const piece of line.length + header.length + 1 > max ? splitLine(line, Math.max(max - header.length - 1, 1)) : [line]) {
      if (current && current.length + piece.length + 1 > max && current !== header) {
        parts.push(current)
        current = header
      }
      current = current ? `${current}\n${piece}` : piece
    }
  }
  if (current && current !== header) parts.push(current)
  return parts
}

function splitBlocks(text, blockMax) {
  return text
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean)
    .flatMap((b) => (b.length > blockMax ? splitLong(b, blockMax) : [b]))
}

// The last ~`chars` characters of `text`, cut at a line/word boundary.
function tail(text, chars) {
  if (text.length <= chars) return text
  const cut = text.slice(text.length - chars)
  const boundary = cut.search(/[\n ]/)
  return boundary === -1 ? cut : cut.slice(boundary + 1)
}

/**
 * pages: [{ page, text, label? }] (label = e.g. "Sheet1 rows 2-41", used as the
 * section when no heading was seen). Returns [{ chunkIdx, page, section, text }].
 */
export function chunkPages(pages, { maxTokens = 700, overlapTokens = 100 } = {}) {
  const maxChars = maxTokens * CHARS_PER_TOKEN
  const overlapChars = overlapTokens * CHARS_PER_TOKEN
  const chunks = []
  for (const { page, text, label = null } of pages) {
    let current = ''
    let heading = null
    let section = label
    const flush = () => {
      if (current.trim()) chunks.push({ page, section, text: current.trim() })
    }
    // Blocks are capped so that overlap + '\n\n' + block always fits in one chunk.
    for (const block of splitBlocks(String(text ?? ''), maxChars - overlapChars - 2)) {
      if (isHeading(block)) heading = block.replace(/^#+\s*/, '').trim()
      if (current && current.length + block.length + 2 > maxChars) {
        flush()
        current = tail(current, overlapChars)
      }
      if (!current) section = heading ?? label
      current = current ? `${current}\n\n${block}` : block
    }
    flush()
  }
  return chunks.map((chunk, chunkIdx) => ({ chunkIdx, ...chunk }))
}

/** The text that is embedded: raw chunk text prefixed with where it came from, so the date and
 *  document survive in the vector ("what did FIIs do on 14 Nov" matches that report's chunks). */
export function embeddingText({ title, reportDate, page, section }, text) {
  const where = [title, reportDate, `p.${page}`, section].filter(Boolean).join(' | ')
  return `[${where}]\n${text}`
}
