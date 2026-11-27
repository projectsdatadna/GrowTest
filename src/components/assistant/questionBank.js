/** Pure helpers of the "+" question picker (Topic -> Exact NSE report name -> Questions to analyse). */

export const MAX_MESSAGE_CHARS = 4000 // same cap as the server (chatRoutes.js) and the text box
export const OPTION_CHAIN_TOPIC = 'Option Chain'
export const WORD_LIMIT_RANGE = [20, 1000] // same range the server accepts

export const findReports = (topics, topic) => topics?.find((t) => t.topic === topic)?.reports ?? []
export const findQuestions = (topics, topic, report) => findReports(topics, topic).find((r) => r.report === report)?.questions ?? []

/**
 * The text box after picking a question. A question never replaces what the user already typed: it goes
 * after it, separated by a blank line (the box is empty -> just the question). If both would not fit in the
 * box, the question alone is used.
 */
export function insertQuestion(current, question, max = MAX_MESSAGE_CHARS) {
  const draft = (current || '').trimEnd()
  if (!draft) return question
  const combined = `${draft}\n\n${question}`
  return combined.length <= max ? combined : question
}

// "Compare with": how far before the chosen time the earlier snapshot is looked up. Same keys as the server.
export const COMPARE_OPTIONS = [
  { value: '15m', label: '15 minutes' },
  { value: '1h', label: '1 hour' },
  { value: '4h', label: '4 hours' },
  { value: '1d', label: '1 day' },
]
export const compareLabel = (value) => COMPARE_OPTIONS.find((o) => o.value === value)?.label ?? ''

const DATE = /^\d{4}-\d{2}-\d{2}$/
const TIME = /^\d{2}:\d{2}$/

/**
 * The option chain part of a question's context, or null when it is not complete.
 * source 'saved' = a stored 15-minute snapshot at `date` + `time` (IST); anything else = the live chain of `expiryDate`.
 */
export function pickedOptionChain({ source, symbol, expiryDate, date, time, compareWith }) {
  const sym = (symbol || '').trim().toUpperCase()
  if (!sym) return null
  const compare = compareWith ? { compareWith } : {}
  if (source === 'saved') return DATE.test(date || '') && TIME.test(time || '') ? { symbol: sym, asOf: { date, time }, ...compare } : null
  return DATE.test(expiryDate || '') ? { symbol: sym, expiryDate, ...compare } : null
}

/** The context sent with a question: the chosen option chain (or none) and an optional word limit. */
export function pickedContext({ topic, symbol, expiryDate, source, date, time, compareWith, wordLimit }) {
  const limit = Number(wordLimit)
  const limitOk = wordLimit !== '' && wordLimit != null && Number.isInteger(limit) && limit >= WORD_LIMIT_RANGE[0] && limit <= WORD_LIMIT_RANGE[1]
  return {
    optionChain: topic === OPTION_CHAIN_TOPIC ? pickedOptionChain({ source, symbol, expiryDate, date, time, compareWith }) : null,
    wordLimit: limitOk ? limit : null,
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** "2026-11-24" -> "24 Nov 2026". */
export const dateLabel = (iso) => (DATE.test(iso || '') ? `${Number(iso.slice(8))} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}` : '')

/** The text of the chip that shows what option chain data goes with the next question. */
export function chipLabel(optionChain) {
  if (!optionChain) return ''
  const what = optionChain.asOf ? `saved ${dateLabel(optionChain.asOf.date)} ${optionChain.asOf.time} IST` : `live · expiry ${optionChain.expiryDate}`
  const versus = optionChain.compareWith ? ` · vs ${compareLabel(optionChain.compareWith)} earlier` : ''
  return `${optionChain.symbol} · ${what}${versus}`
}

/** The topics for the report popup: everything except Option Chain, which has its own popup. */
export const reportTopics = (topics) => (topics ?? []).filter((t) => t.topic !== OPTION_CHAIN_TOPIC)

/** Stored files split into those uploaded for this NSE report and all the others (order kept). */
export function filesForReport(files, report) {
  const list = files ?? []
  return { matching: list.filter((f) => report && f.reportName === report), others: list.filter((f) => !report || f.reportName !== report) }
}

/** Why the word limit is not usable (or '' when it is empty or fine). */
export function wordLimitProblem(wordLimit) {
  if (wordLimit === '' || wordLimit == null) return ''
  const n = Number(wordLimit)
  return Number.isInteger(n) && n >= WORD_LIMIT_RANGE[0] && n <= WORD_LIMIT_RANGE[1] ? '' : `Word limit must be a whole number from ${WORD_LIMIT_RANGE[0]} to ${WORD_LIMIT_RANGE[1]}`
}

/** Why an Option Chain question cannot be picked yet (or '' when it can). */
export function optionChainProblem({ source, symbol, expiryDate, date, time, wordLimit }) {
  if (!(symbol || '').trim()) return 'Pick a symbol first'
  if (source === 'saved') {
    if (!DATE.test(date || '')) return 'Pick a snapshot date first'
    if (!TIME.test(time || '')) return 'Pick a snapshot time first'
  } else if (!DATE.test(expiryDate || '')) return 'Pick an expiry date first'
  return wordLimitProblem(wordLimit)
}

/** Why a report question cannot be picked yet: it needs a topic's report and an attached file. */
export function reportQuestionProblem({ file, wordLimit }) {
  if (!file) return 'Upload a file or pick a stored one first'
  if (file.status === 'uploading') return 'Wait for the upload to finish'
  return wordLimitProblem(wordLimit)
}
