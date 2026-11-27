/**
 * Daily change for a notification card: the bar's close versus the previous
 * trading day's close, taken from the stored 1day candle window.
 * Pure - exported for offline tests.
 */
import { candleEnd } from './crossoverTimeframes.js'

const DAY = 86400
const IST_OFFSET = 19800

// IST calendar day number of an epoch-seconds timestamp.
const istDay = (timestamp) => Math.floor((timestamp + IST_OFFSET) / DAY)
const round2 = (n) => Math.round(n * 100) / 100

/**
 * @param {object} p
 * @param {number|null} p.closePrice  close of the bar the card is for
 * @param {number} p.candleTimestamp  bar start (epoch seconds)
 * @param {string} p.interval
 * @param {Array<{timestamp:number, close:number}>} p.dailyCandles ascending 1day bars
 * @returns {{prevClose:number, dayChange:number, dayChangePct:number}|null}
 */
export function computeDayChange({ closePrice, candleTimestamp, interval, dailyCandles }) {
  if (closePrice == null || !Array.isArray(dailyCandles) || dailyCandles.length === 0) return null
  // Reference day = the day the bar ends on (a weekly bar ends on Friday).
  const refDay = istDay(candleEnd(interval, candleTimestamp) ?? candleTimestamp)
  let prev = null
  for (const candle of dailyCandles) {
    if (istDay(candle.timestamp) < refDay && Number.isFinite(candle.close) && candle.close > 0) prev = candle
    else if (istDay(candle.timestamp) >= refDay) break
  }
  if (!prev) return null
  const dayChange = round2(closePrice - prev.close)
  return { prevClose: round2(prev.close), dayChange, dayChangePct: round2((dayChange / prev.close) * 100) }
}
