import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { BUNDLED_QUESTIONS, groupQuestionBank, questionId } from '../assistant/questionBank.js'
import { registerQuestionBankRoutes } from '../questionBankRoutes.js'

test('bundled bank: 44 rows numbered 1..44, every row has topic, report and question', () => {
  assert.equal(BUNDLED_QUESTIONS.length, 44)
  assert.deepEqual(BUNDLED_QUESTIONS.map((r) => r.no), Array.from({ length: 44 }, (_, i) => i + 1))
  for (const r of BUNDLED_QUESTIONS) for (const k of ['topic', 'report', 'question']) assert.ok(r[k]?.trim(), `row ${r.no} has no ${k}`)
  assert.equal(questionId(7), 'q07')
})

test('groupQuestionBank: six topics in table order, reports and questions under them', () => {
  const topics = groupQuestionBank(BUNDLED_QUESTIONS)
  assert.deepEqual(topics.map((t) => t.topic), ['Index movement – NIFTY and BANK NIFTY', 'Sudden movement detection', 'Market reversal detection', 'Individual F&O stock movement', 'Expiry and rollover movement', 'Option Chain'])
  assert.equal(topics.flatMap((t) => t.reports.flatMap((r) => r.questions)).length, 44)
  const stocks = topics[3].reports.find((r) => r.report === 'F&O – UDiFF Common Bhavcopy Final')
  assert.deepEqual(stocks.questions.map((q) => q.no), [21, 22, 23, 24]) // four questions share one report
  const reversal = topics[2].reports.find((r) => r.report === 'F&O – FII Derivatives Statistics')
  assert.deepEqual(reversal.questions.map((q) => q.no), [15, 16])
  const oc = topics[5]
  assert.deepEqual(oc.reports.map((r) => r.report), ['Option Chain'])
  assert.equal(oc.reports[0].questions.length, 10)
  assert.equal(oc.reports[0].questions[0].signal, 'Call writing or unwinding')
  assert.equal(topics[0].reports[0].questions[0].signal, undefined)
})

test('groupQuestionBank: order comes from `no`, malformed rows are skipped', () => {
  const rows = [
    { no: 2, topic: 'B', report: 'R2', question: 'q2' },
    { no: 1, topic: 'A', report: 'R1', question: 'q1', movement: 'm' },
    { no: 3, topic: 'A', report: 'R1', question: 'q3' },
    { no: 4, topic: 'A', report: '', question: 'no report' },
    { topic: 'A', report: 'R1', question: 'no number' },
  ]
  assert.deepEqual(groupQuestionBank(rows), [
    { topic: 'A', reports: [{ report: 'R1', questions: [{ id: 'q01', no: 1, text: 'q1', movement: 'm' }, { id: 'q03', no: 3, text: 'q3', movement: '' }] }] },
    { topic: 'B', reports: [{ report: 'R2', questions: [{ id: 'q02', no: 2, text: 'q2', movement: '' }] }] },
  ])
  assert.deepEqual(groupQuestionBank(null), [])
})

async function get(store) {
  const app = express()
  registerQuestionBankRoutes(app, { store })
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)) })
  try {
    const res = await fetch(`http://localhost:${server.address().port}/question-bank`)
    return { status: res.status, body: await res.json() }
  } finally {
    server.closeAllConnections()
    server.close()
  }
}

test('GET /question-bank: serves Firestore rows; falls back to the bundled copy when empty or failing', async () => {
  const fromDb = await get({ listQuestionBank: async () => [{ no: 1, topic: 'T', report: 'R', question: 'Q' }] })
  assert.equal(fromDb.status, 200)
  assert.deepEqual(fromDb.body.topics.map((t) => t.topic), ['T'])
  for (const store of [{ listQuestionBank: async () => [] }, { listQuestionBank: async () => { throw new Error('firestore down') } }]) {
    const out = await get(store)
    assert.equal(out.body.status, 'SUCCESS')
    assert.equal(out.body.topics.length, 6)
  }
})
