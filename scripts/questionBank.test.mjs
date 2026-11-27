import test from 'node:test'
import assert from 'node:assert/strict'
import { insertQuestion, findReports, findQuestions, pickedContext, pickedOptionChain, optionChainProblem, reportQuestionProblem, chipLabel, compareLabel, NO_COMPARISON, dateLabel, filesForReport, reportTopics, MAX_MESSAGE_CHARS } from '../src/components/assistant/questionBank.js'

const topics = [
  { topic: 'A', reports: [{ report: 'R1', questions: [{ id: 'q01', text: 'one' }] }, { report: 'R2', questions: [{ id: 'q02', text: 'two' }] }] },
  { topic: 'Option Chain', reports: [{ report: 'Option Chain', questions: [{ id: 'q35', text: 'oc' }] }] },
]

test('insertQuestion: an empty box gets the question; typed text is kept and the question goes after it', () => {
  assert.equal(insertQuestion('', 'Q'), 'Q')
  assert.equal(insertQuestion('   \n', 'Q'), 'Q')
  assert.equal(insertQuestion(undefined, 'Q'), 'Q')
  assert.equal(insertQuestion('My note  ', 'Q'), 'My note\n\nQ')
})

test('insertQuestion: when both do not fit the 4000-character box, the question alone is used', () => {
  assert.equal(insertQuestion('x'.repeat(3990), 'Q'.repeat(20)), 'Q'.repeat(20))
  assert.equal(insertQuestion('x'.repeat(10), 'Q').length, 13)
  assert.ok(MAX_MESSAGE_CHARS === 4000)
})

test('findReports / findQuestions follow the topic and the report', () => {
  assert.deepEqual(findReports(topics, 'A').map((r) => r.report), ['R1', 'R2'])
  assert.deepEqual(findQuestions(topics, 'A', 'R2').map((q) => q.id), ['q02'])
  assert.deepEqual(findReports(topics, 'nope'), [])
  assert.deepEqual(findQuestions(null, 'A', 'R1'), [])
})

test('pickedContext: the option chain only for the Option Chain topic; word limit only when valid', () => {
  assert.deepEqual(pickedContext({ topic: 'Option Chain', symbol: ' nifty ', expiryDate: '2026-12-02', wordLimit: '100' }), { optionChain: { symbol: 'NIFTY', expiryDate: '2026-12-02' }, wordLimit: 100 })
  assert.deepEqual(pickedContext({ topic: 'A', symbol: 'NIFTY', expiryDate: '2026-12-02', wordLimit: '' }), { optionChain: null, wordLimit: null })
  assert.equal(pickedContext({ topic: 'A', wordLimit: '5' }).wordLimit, null)
  assert.equal(pickedContext({ topic: 'A', wordLimit: '1500' }).wordLimit, null)
  assert.equal(pickedContext({ topic: 'Option Chain', symbol: 'NIFTY', expiryDate: '' }).optionChain, null)
})

test('optionChainProblem: tells what is missing', () => {
  assert.match(optionChainProblem({ symbol: '', expiryDate: '2026-12-02' }), /symbol/)
  assert.match(optionChainProblem({ symbol: 'NIFTY', expiryDate: '' }), /expiry/)
  assert.match(optionChainProblem({ symbol: 'NIFTY', expiryDate: '2026-12-02', wordLimit: '10' }), /Word limit/)
  assert.equal(optionChainProblem({ symbol: 'NIFTY', expiryDate: '2026-12-02', wordLimit: '' }), '')
  assert.equal(optionChainProblem({ symbol: 'NIFTY', expiryDate: '2026-12-02' }), '')
})

test('pickedContext: a saved snapshot (date + time) and a compare-with interval; incomplete choices give no option chain', () => {
  const saved = { topic: 'Option Chain', symbol: 'nifty', source: 'saved', date: '2026-11-24', time: '10:15', compareWith: '1h' }
  assert.deepEqual(pickedContext(saved).optionChain, { symbol: 'NIFTY', asOf: { date: '2026-11-24', time: '10:15' }, compareWith: '1h' })
  assert.equal(pickedContext({ ...saved, time: '' }).optionChain, null)
  assert.equal(pickedContext({ ...saved, date: '' }).optionChain, null)
  assert.equal('expiryDate' in pickedContext(saved).optionChain, false)
  assert.deepEqual(pickedContext({ topic: 'Option Chain', symbol: 'NIFTY', source: 'live', expiryDate: '2026-12-01', compareWith: '' }).optionChain, { symbol: 'NIFTY', expiryDate: '2026-12-01' })
  assert.deepEqual(pickedOptionChain({ source: 'live', symbol: 'NIFTY', expiryDate: '2026-12-01', compareWith: '4h' }), { symbol: 'NIFTY', expiryDate: '2026-12-01', compareWith: '4h' })
  assert.equal(pickedContext({ topic: 'A', symbol: 'NIFTY', source: 'saved', date: '2026-11-24', time: '10:15' }).optionChain, null)
})

test('optionChainProblem: a saved snapshot needs a date and a time instead of an expiry', () => {
  assert.match(optionChainProblem({ source: 'saved', symbol: 'NIFTY', date: '', time: '10:15' }), /date/)
  assert.match(optionChainProblem({ source: 'saved', symbol: 'NIFTY', date: '2026-11-24', time: '' }), /time/)
  assert.equal(optionChainProblem({ source: 'saved', symbol: 'NIFTY', date: '2026-11-24', time: '10:15' }), '')
  assert.match(optionChainProblem({ source: 'saved', symbol: '', date: '2026-11-24', time: '10:15' }), /symbol/)
})

test('chipLabel / compareLabel / dateLabel: what the chip above the box says', () => {
  assert.equal(chipLabel({ symbol: 'NIFTY', asOf: { date: '2026-11-24', time: '10:15' }, compareWith: '1h' }), 'NIFTY · saved 24 Nov 2026 10:15 IST · vs 1 hour earlier')
  assert.equal(chipLabel({ symbol: 'NIFTY', expiryDate: '2026-12-01' }), 'NIFTY · live · expiry 2026-12-01')
  assert.equal(chipLabel(null), '')
  assert.deepEqual([compareLabel('15m'), compareLabel('1d'), compareLabel('x')], ['15 minutes', '1 day', ''])
  assert.deepEqual([dateLabel('2026-01-05'), dateLabel('nope')], ['5 Jan 2026', ''])
})

test('filesForReport: files uploaded for the chosen report first, the rest after, order kept; reportTopics hides Option Chain', () => {
  const files = [{ id: 1, reportName: 'R1' }, { id: 2 }, { id: 3, reportName: 'R2' }, { id: 4, reportName: 'R1' }]
  const r = filesForReport(files, 'R1')
  assert.deepEqual([r.matching.map((f) => f.id), r.others.map((f) => f.id)], [[1, 4], [2, 3]])
  assert.deepEqual(filesForReport(files, '').matching, [])
  assert.deepEqual(filesForReport(null, 'R1'), { matching: [], others: [] })
  assert.deepEqual(reportTopics(topics).map((t) => t.topic), ['A'])
  assert.deepEqual(reportTopics(null), [])
})

test('reportQuestionProblem: a question needs a file that has finished uploading', () => {
  assert.match(reportQuestionProblem({ file: null }), /file/)
  assert.match(reportQuestionProblem({ file: { status: 'uploading' } }), /Wait/)
  assert.match(reportQuestionProblem({ file: { status: 'ready' }, wordLimit: '5' }), /Word limit/)
  assert.equal(reportQuestionProblem({ file: { status: 'ready', id: 'x' }, wordLimit: '' }), '')
})

test('"No comparison" is passed through and shown on the chip', () => {
  assert.equal(NO_COMPARISON, 'none')
  const oc = pickedContext({ topic: 'Option Chain', symbol: 'NIFTY', source: 'saved', date: '2026-11-24', time: '10:15', compareWith: 'none' }).optionChain
  assert.deepEqual(oc, { symbol: 'NIFTY', asOf: { date: '2026-11-24', time: '10:15' }, compareWith: 'none' })
  assert.equal(chipLabel(oc), 'NIFTY · saved 24 Nov 2026 10:15 IST · no comparison')
  assert.equal(chipLabel({ symbol: 'NIFTY', expiryDate: '2026-12-01', compareWith: 'none' }), 'NIFTY · live · expiry 2026-12-01 · no comparison')
})
