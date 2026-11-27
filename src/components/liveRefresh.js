/**
 * Pure helpers that keep the Notifications tab from re-rendering / refetching
 * when nothing actually changed (live feed polls, quote refreshes, silent
 * list refreshes). No React or Redux imports so they can be tested in Node.
 */

// Two card/notification lists are the same when every item is identical.
export function sameItems(a = [], b = []) {
  return a.length === b.length && JSON.stringify(a) === JSON.stringify(b)
}

// Quotes are {dayChange, dayChangePct, lastPrice, prevClose} or null/undefined.
export function sameQuote(a, b) {
  if (!a || !b) return !a && !b
  return a.dayChange === b.dayChange && a.dayChangePct === b.dayChangePct && a.lastPrice === b.lastPrice && a.prevClose === b.prevClose
}

// Merges fetched quotes into the stored map; returns the SAME map when nothing differs.
export function mergeQuotes(current, fetched) {
  let next = current
  for (const [key, value] of Object.entries(fetched || {})) {
    if (key in current && sameQuote(current[key], value)) continue
    if (next === current) next = { ...current }
    next[key] = value
  }
  return next
}

// Symbols never fetched, or last fetched at least `windowMs` ago.
export function staleKeys(keys, lastFetched, now, windowMs) {
  return keys.filter((key) => now - (lastFetched.get(key) || 0) >= windowMs)
}

/**
 * Merge polled notifications into the feed. An id already marked read locally
 * stays read. `changed` is false when every fetched item is already known with
 * the same read state - the caller then leaves the feed array untouched.
 */
export function mergeFeedItems(existing, incoming) {
  const known = new Map(existing.map((n) => [n.id, n]))
  let changed = false
  for (const n of incoming) {
    const current = known.get(n.id)
    if (!current) {
      known.set(n.id, n)
      changed = true
    } else if (!current.read && n.read) {
      known.set(n.id, n)
      changed = true
    }
  }
  return { changed, items: changed ? [...known.values()] : existing }
}
