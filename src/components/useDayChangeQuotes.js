/**
 * Live Daily Change / Daily Change % for the symbols on screen, from Groww's
 * quote API via the backend. Fetches in small chunks (results appear as they
 * arrive) and refreshes every minute while the tab is open.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { getDayChangeQuotes } from '../services/api'

const CHUNK = 10
const REFRESH_MS = 60 * 1000

export function quoteKey(item) {
  return `${item.exchange || 'NSE'}:${item.symbol}`
}

/** `groups` = the cards currently listed; returns { "NSE:SYM": quote | null }. */
export function useDayChangeQuotes(groups) {
  const [quotes, setQuotes] = useState({})
  const keysSignature = useMemo(() => [...new Set(groups.map(quoteKey))].sort().join(','), [groups])
  const generation = useRef(0)

  useEffect(() => {
    if (!keysSignature) return undefined
    const keys = keysSignature.split(',')
    let cancelled = false
    const run = async () => {
      const mine = ++generation.current
      for (let i = 0; i < keys.length; i += CHUNK) {
        if (cancelled || mine !== generation.current) return
        const items = keys.slice(i, i + CHUNK).map((k) => {
          const [exchange, symbol] = k.split(':')
          return { exchange, symbol }
        })
        try {
          const result = await getDayChangeQuotes(items)
          if (!cancelled) setQuotes((current) => ({ ...current, ...result }))
        } catch {
          // keep whatever is already shown; the next refresh retries
        }
      }
    }
    run()
    const timer = setInterval(run, REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [keysSignature])

  return quotes
}
