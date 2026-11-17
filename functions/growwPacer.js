/**
 * Process-wide pacing for Groww calls that do not go through the candle
 * fetcher's own limiter (option chain, expiries, quotes): one call per
 * GROWW_MIN_REQUEST_GAP_MS (default 400), and growing waits on HTTP 429.
 */

const GAP_MS = Number(process.env.GROWW_MIN_REQUEST_GAP_MS) || 400
const RETRY_MS = [3000, 10000, 30000]
let nextSlot = 0

export async function paced(fn) {
  for (let attempt = 0; ; attempt++) {
    const now = Date.now()
    const slot = Math.max(now, nextSlot)
    nextSlot = slot + GAP_MS
    if (slot > now) await new Promise((r) => setTimeout(r, slot - now))
    try {
      return await fn()
    } catch (error) {
      const status = error.response?.status ?? error.details?.status_code
      if (status !== 429 || RETRY_MS[attempt] === undefined) throw error
      await new Promise((r) => setTimeout(r, RETRY_MS[attempt]))
    }
  }
}
