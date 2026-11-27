/**
 * Live Daily Change / Daily Change % for the symbols on screen, from Groww's
 * quote API via the backend. Fetches in small chunks (results appear as they
 * arrive) and refreshes every minute while the tab is open.
 *
 * When the visible symbols change (live refreshes bring new cards) only the
 * symbols that were never fetched, or are older than the refresh window, are
 * requested - and after a short debounce so a burst of changes is one fetch.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { getDayChangeQuotes } from '../services/api'
import { mergeQuotes, staleKeys } from './liveRefresh'

const CHUNK = 10
const REFRESH_MS = 60 * 1000
const SIGNATURE_DEBOUNCE_MS = 1000

export function quoteKey(item) {
  return `${item.exchange || 'NSE'}:${item.symbol}`
}

/** `groups` = the cards currently listed; returns { "NSE:SYM": quote | null }. */
export function useDayChangeQuotes(groups) {
  const [quotes, setQuotes] = useState({})
  const keysSignature = useMemo(() => [...new Set(groups.map(quoteKey))].sort().join(','), [groups])
  const lastFetched = useRef(new Map()) // key -> time of the last request

  useEffect(() => {
    if (!keysSignature) return undefined
    const keys = keysSignature.split(',')
    let cancelled = false

    const fetchKeys = async (list) => {
      for (let i = 0; i < list.length; i += CHUNK) {
        if (cancelled) return
        const chunk = list.slice(i, i + CHUNK)
        const now = Date.now()
        chunk.forEach((key) => lastFetched.current.set(key, now))
        const items = chunk.map((k) => {
          const [exchange, symbol] = k.split(':')
          return { exchange, symbol }
        })
        try {
          const result = await getDayChangeQuotes(items)
          // Stored even if this effect was cancelled meanwhile: the key is already marked fetched.
          setQuotes((current) => mergeQuotes(current, result))
        } catch {
          // keep whatever is already shown; the next refresh retries
          chunk.forEach((key) => lastFetched.current.delete(key))
        }
      }
    }

    // Symbols that just appeared (or went stale) are fetched once the list settles.
    const debounce = setTimeout(() => fetchKeys(staleKeys(keys, lastFetched.current, Date.now(), REFRESH_MS)), SIGNATURE_DEBOUNCE_MS)
    const timer = setInterval(() => fetchKeys(keys), REFRESH_MS)
    return () => {
      cancelled = true
      clearTimeout(debounce)
      clearInterval(timer)
    }
  }, [keysSignature])

  return quotes
}
