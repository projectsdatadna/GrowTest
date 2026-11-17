/**
 * Live Daily Change per symbol from Groww's quote API
 * (GET /v1/live-data/quote -> payload.day_change, day_change_perc, last_price,
 * ohlc.close = previous close). Results are cached briefly in memory so many
 * viewers / refreshes of the Notifications tab cost one Groww call per symbol
 * per TTL, and calls are paced to stay inside Groww's rate limit.
 */

import axios from 'axios'
import { paced } from './growwPacer.js'

const QUOTE_URL = 'https://api.groww.in/v1/live-data/quote'
export const QUOTE_TTL_MS = 30 * 1000
const cache = new Map() // "EXCHANGE:SYMBOL" -> {at, value}

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Pure: Groww quote payload -> the fields the UI needs (null when no change given). */
export function parseQuote(payload) {
  const dayChange = finite(payload?.day_change)
  const dayChangePct = finite(payload?.day_change_perc)
  if (dayChange == null || dayChangePct == null) return null
  return {
    dayChange: Math.round(dayChange * 100) / 100,
    dayChangePct: Math.round(dayChangePct * 100) / 100,
    lastPrice: finite(payload.last_price),
    prevClose: finite(payload.ohlc?.close),
  }
}

/** `items` = [{exchange, symbol}] -> { "EXCHANGE:SYMBOL": quote | null }. Per-symbol failures give null. */
export async function fetchDayChangeQuotes(items, groww_token, now = Date.now()) {
  const out = {}
  const unique = [...new Map(items.map((i) => [`${i.exchange}:${i.symbol}`, i])).values()]
  await Promise.all(
    unique.map(async ({ exchange, symbol }) => {
      const key = `${exchange}:${symbol}`
      const hit = cache.get(key)
      if (hit && now - hit.at < QUOTE_TTL_MS) {
        out[key] = hit.value
        return
      }
      try {
        const response = await paced(() =>
          axios.get(QUOTE_URL, {
            headers: { Authorization: `Bearer ${groww_token}`, 'X-API-VERSION': '1.0', Accept: 'application/json' },
            params: { exchange, segment: 'CASH', trading_symbol: symbol },
            timeout: 10000,
          })
        )
        const value = parseQuote(response.data?.payload)
        cache.set(key, { at: Date.now(), value })
        out[key] = value
      } catch (error) {
        console.error(`growwQuotes: ${key} failed:`, error.response?.status || error.message)
        out[key] = hit?.value ?? null
      }
    })
  )
  return out
}
