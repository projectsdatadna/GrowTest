/**
 * Timeframe rules for the Crossover Scanner: when each Groww bar closes, and
 * which bar close the scanner should have processed by a given moment.
 *
 * Verified against Groww sample data (postman/results/*), IST labels:
 *   15minute  bars at :00/:15/:30/:45 from 09:00 to 15:15, plus a stray 15:45
 *             bar (after the 15:30 close - ignored)
 *   1hour     09:00 ... 15:00 (the 09:00 bar covers 9:15-10:00, 15:00 -> 15:30)
 *   4hour     08:00 and 12:00 (08:00 -> 12:00, 12:00 -> 15:30)
 *   1day      00:00, closes 15:30 that day
 *   1week     Monday 00:00, closes Friday 15:30
 *
 * No NSE holiday calendar: a holiday is just a day with no new bars, which the
 * scanner's "did the fetched series actually contain the expected bar" check
 * handles by not advancing.
 */

const IST_OFFSET_SECONDS = 5.5 * 3600
const DAY = 86400
const MARKET_CLOSE_OFFSET = 15 * 3600 + 30 * 60 // 15:30 IST, seconds after IST midnight

// lookbackDays: window loaded for indicator math - sized so SMA 50/200 (the
// slowest crossover) has 200+ bars where Groww history allows. Verified live
// on ULTRACEMCO: 14d 15m ~380 bars, 60d 1h ~295, 179d 4h ~247, 330d 1d ~230,
// 1650d 1w ~235. Every scan re-reads this whole window from Firestore, so it
// is kept no wider than that. tailDays: the
// recent slice re-fetched on every scan so closed bars carry final values.
export const TIMEFRAMES = {
  '15minute': { label: '15 min', seconds: 900, kind: 'intraday', lookbackDays: 14, tailDays: 2 },
  '1hour': { label: '1 hour', seconds: 3600, kind: 'intraday', lookbackDays: 60, tailDays: 3 },
  '4hour': { label: '4 hour', seconds: 14400, kind: 'intraday', lookbackDays: 179, tailDays: 7 },
  '1day': { label: 'Daily', seconds: DAY, kind: 'day', lookbackDays: 330, tailDays: 10 },
  '1week': { label: 'Weekly', seconds: 7 * DAY, kind: 'week', lookbackDays: 1650, tailDays: 35 },
}

export const TIMEFRAME_ORDER = ['15minute', '1hour', '4hour', '1day', '1week']

export const DEFAULT_ENABLED_INTERVALS = [...TIMEFRAME_ORDER]
// 15-minute alerts go to the Notifications page and bell only, by default.
export const DEFAULT_POPUP_INTERVALS = ['1hour', '4hour', '1day', '1week']

// Expected bar-close offsets (seconds after IST midnight) on a trading day.
const EXPECTED_END_OFFSETS = {
  // 09:30, 09:45 ... 15:30
  '15minute': Array.from({ length: 25 }, (_, i) => 9 * 3600 + 30 * 60 + i * 900),
  // 10:00 ... 15:00, then 15:30
  '1hour': [...Array.from({ length: 6 }, (_, i) => (10 + i) * 3600), MARKET_CLOSE_OFFSET],
  '4hour': [12 * 3600, MARKET_CLOSE_OFFSET],
  '1day': [MARKET_CLOSE_OFFSET],
  '1week': [MARKET_CLOSE_OFFSET], // Fridays only - see latestExpectedBarEnd
}

function istDayStart(timestamp) {
  return Math.floor((timestamp + IST_OFFSET_SECONDS) / DAY) * DAY - IST_OFFSET_SECONDS
}

// 0 = Sunday ... 6 = Saturday, for the IST calendar day containing `timestamp`.
function istWeekday(timestamp) {
  const daysSinceEpoch = Math.floor((timestamp + IST_OFFSET_SECONDS) / DAY)
  return (daysSinceEpoch + 4) % 7 // 1970-01-01 was a Thursday
}

export function isTimeframe(interval) {
  return Object.hasOwn(TIMEFRAMES, interval)
}

/**
 * Epoch-seconds time at which the bar starting at `start` is complete, or
 * null when `start` isn't a real trading bar (e.g. the stray 15:45 bar that
 * Groww returns after the close).
 */
export function candleEnd(interval, start) {
  const { kind, seconds } = TIMEFRAMES[interval]
  const dayStart = istDayStart(start)
  const close = dayStart + MARKET_CLOSE_OFFSET

  if (kind === 'intraday') {
    if (start >= close) return null
    return Math.min(start + seconds, close)
  }
  if (kind === 'day') return close
  // week: the Friday of the week containing `start`
  const mondayStart = dayStart - ((istWeekday(start) + 6) % 7) * DAY
  return mondayStart + 4 * DAY + MARKET_CLOSE_OFFSET
}

export function isCandleClosed(interval, start, nowSeconds) {
  const end = candleEnd(interval, start)
  return end != null && end <= nowSeconds
}

/**
 * The most recent bar close (epoch seconds) that should exist at `nowSeconds`
 * on a Mon-Fri calendar, or null if none within the last 10 days. A symbol is
 * "due" for this interval when its stored lastBarEnd is older than this.
 */
export function latestExpectedBarEnd(interval, nowSeconds) {
  const offsets = EXPECTED_END_OFFSETS[interval]
  const weeklyOnly = interval === '1week'
  const today = istDayStart(nowSeconds)

  for (let back = 0; back <= 10; back++) {
    const dayStart = today - back * DAY
    const weekday = istWeekday(dayStart + 12 * 3600)
    if (weekday < 1 || weekday > 5) continue
    if (weeklyOnly && weekday !== 5) continue
    for (let i = offsets.length - 1; i >= 0; i--) {
      const end = dayStart + offsets[i]
      if (end <= nowSeconds) return end
    }
  }
  return null
}

/**
 * Whether the dispatcher should do anything at `now`: a trading weekday from
 * 09:30 to 18:30 IST. The tail until 18:30 exists so Daily/Weekly bars that
 * Groww publishes late after the 15:30 close are still retried.
 */
export function isDispatchWindow(now = new Date()) {
  const ts = Math.floor(now.getTime() / 1000)
  const weekday = istWeekday(ts)
  if (weekday < 1 || weekday > 5) return false
  const offset = ts - istDayStart(ts)
  return offset >= 9 * 3600 + 30 * 60 && offset <= 18 * 3600 + 30 * 60
}
