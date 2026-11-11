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
// slowest crossover) has 200+ bars where Groww history allows. Measured live on
// ULTRACEMCO: 14d of 15m ~265 bars, 60d of 1h ~285, 179d of 4h ~247, 330d of
// 1d ~222, 1650d of 1w ~235. tailDays: the recent slice re-fetched on every
// scan so closed bars carry final values. maxBars: the stored window is capped
// at this many bars (one Firestore document per symbol+timeframe, see
// crossoverCandleWindow.js).
export const TIMEFRAMES = {
  '15minute': { label: '15 min', seconds: 900, kind: 'intraday', lookbackDays: 14, tailDays: 2, maxBars: 300 },
  '1hour': { label: '1 hour', seconds: 3600, kind: 'intraday', lookbackDays: 60, tailDays: 3, maxBars: 320 },
  '4hour': { label: '4 hour', seconds: 14400, kind: 'intraday', lookbackDays: 179, tailDays: 7, maxBars: 270 },
  '1day': { label: 'Daily', seconds: DAY, kind: 'day', lookbackDays: 330, tailDays: 10, maxBars: 260 },
  '1week': { label: 'Weekly', seconds: 7 * DAY, kind: 'week', lookbackDays: 1650, tailDays: 35, maxBars: 260 },
}

export const TIMEFRAME_ORDER = ['15minute', '1hour', '4hour', '1day', '1week']

export const DEFAULT_ENABLED_INTERVALS = [...TIMEFRAME_ORDER]
// Every crossover pops up instantly on every timeframe by default (the popup
// updates live, see CrossoverAlertPopup); untick a timeframe on the Scanner
// page to keep it to the Notifications page and bell only.
export const DEFAULT_POPUP_INTERVALS = [...TIMEFRAME_ORDER]

// Bump when the defaults above change meaning, so getScannerSettings can reset
// values saved under the previous defaults (see crossoverScannerFirestoreClient).
export const SETTINGS_VERSION = 2

// Minimum number of indicators that must agree (cross the same direction
// within the last few bars) before a crossover pops up. Every crossover is
// stored and listed regardless; 1 means every crossover pops up.
export const DEFAULT_MIN_AGREEMENT = { '15minute': 1, '1hour': 1, '4hour': 1, '1day': 1, '1week': 1 }
export const MIN_AGREEMENT_RANGE = [1, 7]

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

// Bar end for ANY start second (candleEnd returns null for a start after the
// close; here such a start maps to that day's close so the function stays
// non-decreasing in `start`, which the range search below relies on).
function monotoneBarEnd(interval, start) {
  return candleEnd(interval, start) ?? istDayStart(start) + MARKET_CLOSE_OFFSET
}

/**
 * Converts a range on the time a crossover is DISPLAYED (its bar end, epoch
 * seconds) into the equivalent range on the stored bar START (`candleTimestamp`),
 * which is the field Firestore can filter on. Bar end never decreases as the
 * start increases, so each bound is found by binary search.
 * `fromEnd` / `toEnd` are optional; returns {gte, lte} (each possibly undefined).
 */
export function candleStartRangeForEndRange(interval, fromEnd, toEnd) {
  const SPAN = 14 * DAY // far beyond any bar's start->end distance (max ~5 days)
  const bound = (target, wantFirstAtLeast) => {
    // wantFirstAtLeast: smallest start with end >= target; else largest start with end <= target
    let lo = target - SPAN
    let hi = target + SPAN
    while (lo < hi) {
      const mid = wantFirstAtLeast ? Math.floor((lo + hi) / 2) : Math.ceil((lo + hi) / 2)
      const end = monotoneBarEnd(interval, mid)
      if (wantFirstAtLeast) {
        if (end >= target) hi = mid
        else lo = mid + 1
      } else if (end <= target) lo = mid
      else hi = mid - 1
    }
    return lo
  }
  return {
    gte: fromEnd == null ? undefined : bound(fromEnd, true),
    lte: toEnd == null ? undefined : bound(toEnd, false),
  }
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

// Minutes after IST midnight for the weekday `now` falls on, or null on a weekend.
function istWeekdayMinutes(now) {
  const ts = Math.floor(now.getTime() / 1000)
  const weekday = istWeekday(ts)
  if (weekday < 1 || weekday > 5) return null
  return Math.floor((ts - istDayStart(ts)) / 60)
}

// Cloud Scheduler can fire a minute or two late; accept that much slack.
const TICK_SLACK_MINUTES = 2

/**
 * The 15-minute scan ticks: weekdays 09:15, 09:30 ... 15:15 (25 ticks), at the
 * :00/:15/:30/:45 marks the scheduler fires on. Whatever bar closed by then and
 * is not scanned yet gets scanned (a bar Groww has not published yet is retried
 * by the settle pass, see runScheduledScan in functions/index.js).
 */
export function isQuarterHourTick(now = new Date()) {
  const minutes = istWeekdayMinutes(now)
  if (minutes == null) return false
  const quarter = minutes - (minutes % 15)
  return minutes - quarter <= TICK_SLACK_MINUTES && quarter >= 9 * 60 + 15 && quarter <= 15 * 60 + 15
}

/**
 * The close-out ticks: weekdays 15:32 (everything that closed at 15:30 - last
 * 15-min bar, 1h, 4h, Daily, Weekly on Fridays) and 16:32 / 17:32 / 18:32,
 * which retry Daily/Weekly bars that Groww publishes late.
 */
export function isCloseoutTick(now = new Date()) {
  const minutes = istWeekdayMinutes(now)
  if (minutes == null) return false
  const hour = Math.floor(minutes / 60)
  const minute = minutes % 60
  return hour >= 15 && hour <= 18 && minute >= 32 && minute <= 32 + TICK_SLACK_MINUTES
}
