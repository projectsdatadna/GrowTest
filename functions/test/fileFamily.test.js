import test from 'node:test'
import assert from 'node:assert/strict'
import { familyKey, effectiveDate, orderVersions, versionInfo, currentAndPrevious, groupFamilies } from '../assistant/fileFamily.js'
import { stripDates } from '../ingest/reportDate.js'

const f = (id, fileName, reportDate, uploadedAt = null) => ({ id, fileName, title: fileName.replace(/\.[^.]+$/, ''), reportDate, uploadedAt })

test('stripDates removes valid dates in every supported format, leaves other numbers', () => {
  assert.equal(stripDates('FII_14-11-2025').replace(/\s+/g, ' ').trim(), 'FII_')
  assert.equal(stripDates('FII 20 Nov 2025 (1)').replace(/\s+/g, ' ').trim(), 'FII (1)')
  assert.equal(stripDates('FII 2025-11-14 v2').replace(/\s+/g, ' ').trim(), 'FII v2')
  assert.equal(stripDates('Nifty 50 report'), 'Nifty 50 report')
})

test('familyKey: the same document across dates, copies and versions; other documents stay apart', () => {
  const key = (name) => familyKey(f('x', name, null))
  assert.equal(key('FII_Report_14-11-2025.pdf'), 'fii report')
  assert.equal(key('FII Report 20 Nov 2025 (1).pdf'), 'fii report')
  assert.equal(key('fii-report-copy.pdf'), 'fii report')
  assert.equal(key('FII Report v2.xlsx'), 'fii report')
  assert.equal(key('CMVOLT_20112026.csv'), 'cmvolt', 'an 8-digit date')
  assert.notEqual(key('DII Report 14-11-2025.pdf'), key('FII Report 14-11-2025.pdf'))
  assert.equal(key('2025-11-14.pdf'), 'file', 'a name that is only a date')
})

test('versions: dated by report date, else the IST upload day; ordered oldest first; numbered per document', () => {
  const a = f('a', 'FII 10-11-2025.pdf', '2025-11-10', '2025-11-21T01:00:00Z')
  const b = f('b', 'FII.pdf', null, '2025-11-19T20:00:00Z') // 20 Nov 01:30 IST
  const c = f('c', 'FII 14-11-2025.pdf', '2025-11-14', '2025-11-22T01:00:00Z')
  const other = f('o', 'DII.pdf', '2025-11-12', '2025-11-22T01:00:00Z')
  assert.equal(effectiveDate(b), '2025-11-20')
  assert.deepEqual(orderVersions([b, c, a]).map((x) => x.id), ['a', 'c', 'b'])
  const info = versionInfo([a, b, c, other])
  assert.deepEqual([info.get('a'), info.get('c'), info.get('b')].map((v) => [v.n, v.of]), [[1, 3], [2, 3], [3, 3]])
  assert.deepEqual([info.get('o').n, info.get('o').of], [1, 1])
  assert.equal(groupFamilies([a, b, c, other]).size, 2)
})

test('currentAndPrevious: newest and the one before; same-day uploads tie-break on upload time', () => {
  const a = f('a', 'R 10-11-2025.pdf', '2025-11-10', '2025-11-10T05:00:00Z')
  const b = f('b', 'R 14-11-2025.pdf', '2025-11-14', '2025-11-14T05:00:00Z')
  assert.deepEqual(Object.values(currentAndPrevious([b, a])).map((x) => x.id), ['b', 'a'])
  const b2 = f('b2', 'R 14-11-2025 (1).pdf', '2025-11-14', '2025-11-14T09:00:00Z')
  const both = currentAndPrevious([a, b, b2])
  assert.deepEqual([both.current.id, both.previous.id], ['b2', 'a'], 'the previous version is the one from an earlier date')
  const sameDay = currentAndPrevious([b, b2])
  assert.deepEqual([sameDay.current.id, sameDay.previous.id], ['b2', 'b'], 'all on one day: the upload before it')
  assert.deepEqual(currentAndPrevious([a]), { current: a, previous: null })
})
