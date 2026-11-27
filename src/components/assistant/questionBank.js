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

/** The context sent with a question: the chosen option chain (or none) and an optional word limit. */
export function pickedContext({ topic, symbol, expiryDate, wordLimit }) {
  const limit = Number(wordLimit)
  const limitOk = wordLimit !== '' && wordLimit != null && Number.isInteger(limit) && limit >= WORD_LIMIT_RANGE[0] && limit <= WORD_LIMIT_RANGE[1]
  const sym = (symbol || '').trim().toUpperCase()
  return {
    optionChain: topic === OPTION_CHAIN_TOPIC && sym && /^\d{4}-\d{2}-\d{2}$/.test(expiryDate || '') ? { symbol: sym, expiryDate } : null,
    wordLimit: limitOk ? limit : null,
  }
}

/** Why the word limit is not usable (or '' when it is empty or fine). */
export function wordLimitProblem(wordLimit) {
  if (wordLimit === '' || wordLimit == null) return ''
  const n = Number(wordLimit)
  return Number.isInteger(n) && n >= WORD_LIMIT_RANGE[0] && n <= WORD_LIMIT_RANGE[1] ? '' : `Word limit must be a whole number from ${WORD_LIMIT_RANGE[0]} to ${WORD_LIMIT_RANGE[1]}`
}

/** Why an Option Chain question cannot be picked yet (or '' when it can). */
export function optionChainProblem({ symbol, expiryDate, wordLimit }) {
  if (!(symbol || '').trim()) return 'Pick a symbol first'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiryDate || '')) return 'Pick an expiry date first'
  return wordLimitProblem(wordLimit)
}
