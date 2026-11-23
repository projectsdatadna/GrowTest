/**
 * Dates in a user's question -> a retrieval filter. Deterministic (no LLM): the
 * date logic must be exact and testable. All dates are IST calendar dates
 * (YYYY-MM-DD) because that is how report dates are stored.
 *
 *   "FII on 14 Nov 2025"            -> dates: ['2025-11-14']
 *   "compare 14 Nov with 10 Nov"     -> dates: ['2025-11-10','2025-11-14']  (exactly those two)
 *   "between 10 Nov and 14 Nov"      -> range 2025-11-10..2025-11-14
 *   "last week", "last 7 days", "this month", "in October", "yesterday", "today"
 *   "latest report", "most recent"   -> latest: true (resolved against the library)
 * A date without a year is the most recent such date not in the future.
 */

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const MONTH_RE = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?'
const monthIndex = (name) => MONTHS.findIndex((m) => m.startsWith(name.toLowerCase().slice(0, 3))) + 1

const pad = (n) => String(n).padStart(2, '0')
const fmt = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
const utc = (y, m, d) => new Date(Date.UTC(y, m - 1, d))
const addDays = (d, n) => new Date(d.getTime() + n * 86400000)
const validDate = (y, m, d) => {
  const t = utc(y, m, d)
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? t : null
}

/** Today's IST calendar date as a UTC-midnight Date. */
export function istToday(now = new Date()) {
  const ist = new Date(now.getTime() + 5.5 * 3600000)
  return utc(ist.getUTCFullYear(), ist.getUTCMonth() + 1, ist.getUTCDate())
}

const fullYear = (y) => (y < 100 ? 2000 + y : y)

// Day + month without a year: this year, or last year if that would be in the future.
function yearless(day, month, today) {
  let candidate = validDate(today.getUTCFullYear(), month, day)
  if (candidate && candidate > today) candidate = validDate(today.getUTCFullYear() - 1, month, day)
  return candidate
}

// Explicit dates in order of appearance, each match blanked out so no pattern double counts it.
export function findAllDates(text, today) {
  let rest = ` ${text} `
  const found = []
  const take = (regex, toDate) => {
    rest = rest.replace(regex, (...args) => {
      const groups = args.slice(1, -2)
      const date = toDate(groups)
      if (!date) return args[0]
      found.push({ index: args[args.length - 2], date })
      return ' '.repeat(args[0].length)
    })
  }
  take(/(?<!\d)(\d{4})[-_.\/](\d{1,2})[-_.\/](\d{1,2})(?!\d)/g, ([y, m, d]) => validDate(+y, +m, +d))
  take(new RegExp(`(?<![\\d])(\\d{1,2})(?:st|nd|rd|th)?[\\s\\-_.,]*(${MONTH_RE})[a-z]*\\.?[\\s\\-_.,]*(\\d{4}|\\d{2})(?!\\d)`, 'gi'), ([d, m, y]) => validDate(fullYear(+y), monthIndex(m), +d))
  take(new RegExp(`\\b(${MONTH_RE})[a-z]*\\.?[\\s\\-_.]*(\\d{1,2})(?:st|nd|rd|th)?,?[\\s\\-_.]+(\\d{4})(?!\\d)`, 'gi'), ([m, d, y]) => validDate(+y, monthIndex(m), +d))
  take(/(?<!\d)(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})(?!\d)/g, ([d, m, y]) => validDate(+y, +m, +d))
  take(new RegExp(`(?<!\\d)(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s+)?(${MONTH_RE})(?![a-z])`, 'gi'), ([d, m]) => yearless(+d, monthIndex(m), today))
  take(new RegExp(`\\b(${MONTH_RE})(?![a-z])\\.?\\s*(\\d{1,2})(?:st|nd|rd|th)?(?!\\d|\\s*[:%])`, 'gi'), ([m, d]) => yearless(+d, monthIndex(m), today))
  return found.sort((a, b) => a.index - b.index).map((f) => f.date)
}

function monthRange(year, month) {
  const from = utc(year, month, 1)
  return { from: fmt(from), to: fmt(addDays(utc(year, month + 1, 1), -1)) }
}

/**
 * -> { dates: string[], range: {from,to}|null, latest: boolean, matched: string[] }
 * `dates` = specific days asked about (sorted, unique); `range` = an interval;
 * both empty and latest false = the question names no date.
 */
export function extractDateFilter(question, { now = new Date() } = {}) {
  const text = String(question || '')
  const lower = text.toLowerCase()
  const today = istToday(now)
  const matched = []
  const result = { dates: [], range: null, latest: false, matched }

  const explicit = findAllDates(text, today)
  const isRange = /\b(between|from)\b[^.?!]*\b(and|to|till|until|through)\b/.test(lower) || /\b(?:to|till|until|through)\b/.test(lower) && explicit.length === 2 && !/\b(compare|vs|versus|against|with)\b/.test(lower)
  if (explicit.length >= 2 && isRange) {
    const sorted = explicit.map(fmt).sort()
    result.range = { from: sorted[0], to: sorted[sorted.length - 1] }
    matched.push('range')
  } else if (explicit.length) {
    result.dates = [...new Set(explicit.map(fmt))].sort()
    matched.push('dates')
  }
  if (explicit.length) return result

  let m
  if (/\byesterday\b/.test(lower)) {
    result.dates = [fmt(addDays(today, -1))]
    matched.push('yesterday')
  } else if (/\btoday\b|\btoday's\b/.test(lower)) {
    result.dates = [fmt(today)]
    matched.push('today')
  } else if ((m = /\b(?:last|past|previous)\s+(\d{1,3})\s+(day|week|month)s?\b/.exec(lower))) {
    const n = Number(m[1]) * (m[2] === 'day' ? 1 : m[2] === 'week' ? 7 : 30)
    result.range = { from: fmt(addDays(today, -(n - 1))), to: fmt(today) }
    matched.push('lastN')
  } else if (/\blast week\b|\bprevious week\b/.test(lower)) {
    const monday = addDays(today, -((today.getUTCDay() + 6) % 7))
    result.range = { from: fmt(addDays(monday, -7)), to: fmt(addDays(monday, -1)) }
    matched.push('lastWeek')
  } else if (/\bthis week\b/.test(lower)) {
    result.range = { from: fmt(addDays(today, -((today.getUTCDay() + 6) % 7))), to: fmt(today) }
    matched.push('thisWeek')
  } else if (/\blast month\b|\bprevious month\b/.test(lower)) {
    const prev = utc(today.getUTCFullYear(), today.getUTCMonth(), 1)
    result.range = monthRange(prev.getUTCFullYear(), prev.getUTCMonth() + 1)
    matched.push('lastMonth')
  } else if (/\bthis month\b/.test(lower)) {
    result.range = { from: fmt(utc(today.getUTCFullYear(), today.getUTCMonth() + 1, 1)), to: fmt(today) }
    matched.push('thisMonth')
  } else if ((m = new RegExp(`\\b(?:in|during|for|of|throughout)\\s+(${MONTH_RE})(?![a-z])(?:\\s+(\\d{4}))?`, 'i').exec(text)) || (m = new RegExp(`\\b(${MONTH_RE})(?![a-z])\\s+(\\d{4})\\b`, 'i').exec(text))) {
    const month = monthIndex(m[1])
    let year = m[2] ? Number(m[2]) : today.getUTCFullYear()
    if (!m[2] && month > today.getUTCMonth() + 1) year -= 1
    result.range = monthRange(year, month)
    matched.push('month')
  }
  if (!result.dates.length && !result.range && /\b(latest|most recent|newest|current|recent)\b/.test(lower)) {
    result.latest = true
    matched.push('latest')
  }
  return result
}

/** Merge the question's dates with an explicit scope ({from,to,docType,docIds}); the scope wins. */
export function mergeScope(extracted, scope = {}) {
  const filter = { docType: scope.docType || null, docIds: scope.docIds?.length ? scope.docIds : null, dates: null, from: null, to: null, latest: false }
  if (scope.from || scope.to) {
    filter.from = scope.from || null
    filter.to = scope.to || null
  } else if (extracted.dates.length) filter.dates = extracted.dates
  else if (extracted.range) ({ from: filter.from, to: filter.to } = extracted.range)
  else filter.latest = extracted.latest
  return filter
}
