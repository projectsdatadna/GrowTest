import test from 'node:test'
import assert from 'node:assert/strict'
import { insertQuestion, findReports, findQuestions, pickedContext, optionChainProblem, MAX_MESSAGE_CHARS } from '../src/components/assistant/questionBank.js'

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
