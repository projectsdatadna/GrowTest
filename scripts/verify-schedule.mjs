/**
 * Offline check of the scan schedule: replays the real cron firings
 * (crossoverScanDispatch '0,15,30,45 9-15' + crossoverScanCloseout '32 15-18',
 * weekdays IST) through the real gates / due rules over a week and asserts when
 * each timeframe's bars get scanned. Run: node scripts/verify-schedule.mjs
 */
import { isQuarterHourTick, isCloseoutTick, latestExpectedBarEnd, TIMEFRAME_ORDER } from '../functions/crossoverTimeframes.js'
import { isIntervalDue } from '../functions/crossoverScanner.js'

let failures = 0
const check = (ok, message) => {
  console.log(`${ok ? '✓' : '✗'} ${message}`)
  if (!ok) failures++
}
const IST = 5.5 * 3600
const istSeconds = (day, hh, mm, ss = 0) => Date.UTC(2026, 10, day, hh, mm, ss) / 1000 - IST // Nov `day`, IST wall clock
const fmt = (sec) => new Date((sec + IST) * 1000).toISOString().slice(5, 16).replace('T', ' ')
const weekday = (day) => new Date(Date.UTC(2026, 10, day)).getUTCDay()

// Cron firings in order (both jobs), as [seconds, gate-result, job].
const firings = []
for (let day = 8; day <= 15; day++) {
  const wd = weekday(day)
  if (wd < 1 || wd > 5) {
    // weekend: scheduler cron is Mon-Fri, so nothing fires; check the gates anyway
    for (const [h, m] of [[9, 15], [12, 0], [15, 32]]) {
      const t = istSeconds(day, h, m)
      check(!isQuarterHourTick(new Date(t * 1000)) && !isCloseoutTick(new Date(t * 1000)), `weekend ${fmt(t)}: gates closed`)
    }
    continue
  }
  for (let h = 9; h <= 15; h++) for (const m of [0, 15, 30, 45]) firings.push({ t: istSeconds(day, h, m, 1), job: 'dispatch', day })
  for (let h = 15; h <= 18; h++) firings.push({ t: istSeconds(day, h, 32, 1), job: 'closeout', day })
}
firings.sort((a, b) => a.t - b.t)

const ticksPerDay = {}
const scans = [] // {interval, barEnd, at}
const state = Object.fromEntries(TIMEFRAME_ORDER.map((i) => [i, { lastBarEnd: istSeconds(8, 0, 0) }]))
// Groww publishes a bar ~60-70 s after its close; a settle pass 90 s after the tick catches it.
const PUBLISH_LAG = 70
const runPass = (t) => {
  for (const interval of TIMEFRAME_ORDER) {
    if (!isIntervalDue(interval, state[interval], t)) continue
    const expected = latestExpectedBarEnd(interval, t)
    if (t < expected + PUBLISH_LAG) continue // not published yet
    scans.push({ interval, barEnd: expected, at: t })
    state[interval] = { lastBarEnd: expected }
  }
}
for (const f of firings) {
  const gate = f.job === 'dispatch' ? isQuarterHourTick : isCloseoutTick
  const open = gate(new Date(f.t * 1000))
  if (f.job === 'dispatch') {
    const inWindow = f.t >= istSeconds(f.day, 9, 15) && f.t <= istSeconds(f.day, 15, 15, 30)
    if (open !== inWindow) check(false, `dispatch gate at ${fmt(f.t)} = ${open}, expected ${inWindow}`)
    if (open) ticksPerDay[f.day] = (ticksPerDay[f.day] || 0) + 1
  }
  if (!open) continue
  runPass(f.t)
  runPass(f.t + 90) // settle pass
}

for (const [day, n] of Object.entries(ticksPerDay)) check(n === 25, `Nov ${day}: ${n} quarter-hour ticks (09:15 ... 15:15) = 25`)
const closeoutCount = firings.filter((f) => f.job === 'closeout' && isCloseoutTick(new Date(f.t * 1000))).length
check(closeoutCount === 4 * 5, `${closeoutCount} close-out ticks (15:32, 16:32, 17:32, 18:32 x 5 weekdays) = 20`)
check(!isQuarterHourTick(new Date(istSeconds(9, 9, 0, 1) * 1000)), '09:00 does not tick (first tick is 09:15)')
check(!isQuarterHourTick(new Date(istSeconds(9, 15, 30, 1) * 1000)), '15:30 does not tick (last 15-min tick is 15:15; 15:32 is the close-out)')

for (const interval of TIMEFRAME_ORDER) {
  const mine = scans.filter((s) => s.interval === interval)
  const keys = mine.map((s) => s.barEnd)
  check(new Set(keys).size === keys.length, `${interval}: no bar scanned twice (${keys.length} scans)`)
}
const by = (interval) => scans.filter((s) => s.interval === interval)
const clock = (sec) => fmt(sec).slice(6)

// 15-minute: each bar closing 09:30..15:30 scanned within 15 minutes of its close (same tick's settle pass).
const m15 = by('15minute')
const m15late = m15.filter((s) => s.at - s.barEnd > 900)
check(m15.length === 25 * 5 || m15.length >= 24 * 5, `15minute: ${m15.length} bar scans over 5 weekdays`)
check(m15late.length === 0, `15minute: every bar scanned within 15 min of its close (worst ${Math.max(...m15.map((s) => s.at - s.barEnd))} s)`)
check(m15.some((s) => clock(s.barEnd) === '09:30'), '15minute: first bar of the day (closes 09:30) is scanned')
check(m15.filter((s) => clock(s.barEnd) === '15:30').every((s) => clock(s.at) === '15:32' || clock(s.at) === '15:33'), '15minute: last bar (closes 15:30) scanned by the 15:32 close-out')

// 1-hour: bars closing 10:00..15:00 scanned on the :00 tick (settle), 15:30 at close-out.
const h1 = by('1hour')
check(h1.every((s) => s.at - s.barEnd <= 150), `1hour: each bar scanned within 2.5 min of its close (${h1.length} scans)`)
// 4-hour: closes 12:00 and 15:30 only.
const h4 = by('4hour')
const h4times = [...new Set(h4.map((s) => clock(s.barEnd)))].sort()
check(h4times.join(',') === '12:00,15:30', `4hour: bars close at ${h4times.join(', ')} (Groww's two bars/day)`)
check(h4.filter((s) => clock(s.barEnd) === '12:00').every((s) => s.at - s.barEnd <= 150), '4hour: 12:00 bar scanned within 2.5 min of its close')
check(h4.filter((s) => clock(s.barEnd) === '15:30').every((s) => clock(s.at) === '15:32' || clock(s.at) === '15:33'), '4hour: 15:30 bar scanned at the 15:32 close-out')
// Daily / weekly
const d1 = by('1day')
check(d1.length === 5 && d1.every((s) => clock(s.at) === '15:32' || clock(s.at) === '15:33'), `1day: ${d1.length} scans, all at the 15:32 close-out`)
const w1 = by('1week')
check(w1.length === 1 && weekday(Number(fmt(w1[0].barEnd).slice(3, 5))) === 5 && clock(w1[0].at).startsWith('15:3'), '1week: scanned once, on Friday at the 15:32 close-out')

if (failures) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nAll schedule checks passed.')
