/**
 * Best-effort report date (YYYY-MM-DD, IST calendar date) from a file name or the
 * start of a document. Indian convention: day first. Returns null when nothing
 * plausible is found - the UI then asks the user (a date is required for FII reports).
 */

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 }
const MONTH_NAMES = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?'

export function isoDate(year, month, day, { now = new Date() } = {}) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null
  if (year < 2000 || year > now.getUTCFullYear() + 1) return null
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return date.toISOString().slice(0, 10)
}

const monthNumber = (name) => MONTHS[name.toLowerCase().slice(0, name.toLowerCase().startsWith('sept') ? 4 : 3)] ?? MONTHS[name.toLowerCase().slice(0, 3)]
const fullYear = (y) => (y < 100 ? 2000 + y : y)

// [regex, (match) => [y, m, d]] in order of reliability; first valid hit wins.
const PATTERNS = [
  [/(?<!\d)(\d{4})[-_.\/](\d{1,2})[-_.\/](\d{1,2})(?!\d)/, (m) => [+m[1], +m[2], +m[3]]], // 2025-11-14
  [new RegExp(`(?<!\\d)(\\d{1,2})(?:st|nd|rd|th)?[\\s\\-_.,]*(${MONTH_NAMES})[a-z]*[\\s\\-_.,]*(\\d{2,4})(?!\\d)`, 'i'), (m) => [fullYear(+m[3]), monthNumber(m[2]), +m[1]]], // 14 Nov 2025, 14-Nov-25
  [new RegExp(`(${MONTH_NAMES})[a-z]*[\\s\\-_.]*(\\d{1,2})(?:st|nd|rd|th)?[\\s\\-_.,]+(\\d{4})(?!\\d)`, 'i'), (m) => [+m[3], monthNumber(m[1]), +m[2]]], // Nov 14, 2025
  [/(?<!\d)(\d{1,2})[-_.\/](\d{1,2})[-_.\/](\d{4})(?!\d)/, (m) => [+m[3], +m[2], +m[1]]], // 14-11-2025, 14/11/2025
  [/(?<!\d)(\d{2})(\d{2})(\d{4})(?!\d)/, (m) => [+m[3], +m[2], +m[1]]], // 14112025
  [/(?<!\d)(\d{4})(\d{2})(\d{2})(?!\d)/, (m) => [+m[1], +m[2], +m[3]]], // 20251114
]

export function findDateIn(text, options) {
  for (const [regex, pick] of PATTERNS) {
    const match = regex.exec(text)
    if (!match) continue
    const [y, m, d] = pick(match)
    const date = isoDate(y, m, d, options)
    if (date) return date
  }
  return null
}

/** The text with every valid date removed (replaced by a space) - used to tell which files are versions of one document. */
export function stripDates(text, options) {
  let rest = String(text)
  for (const [regex, pick] of PATTERNS) {
    const global = new RegExp(regex.source, `${regex.flags.replace('g', '')}g`)
    rest = rest.replace(global, (...args) => {
      const groups = args.slice(0, -2)
      const [y, m, d] = pick(groups)
      return isoDate(y, m, d, options) ? ' ' : groups[0]
    })
  }
  return rest
}

/** { date, source: 'filename' | 'text' } or null. */
export function detectReportDate({ fileName = '', text = '' }, options) {
  const fromName = findDateIn(fileName.replace(/\.[A-Za-z0-9]+$/, ''), options)
  if (fromName) return { date: fromName, source: 'filename' }
  const fromText = findDateIn(String(text).slice(0, 3000), options)
  return fromText ? { date: fromText, source: 'text' } : null
}
