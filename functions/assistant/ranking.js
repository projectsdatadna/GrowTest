/**
 * Hybrid ranking of vector-search candidates: reciprocal-rank fusion of the vector
 * order and a keyword-overlap order. The keyword side is what rescues exact
 * numbers, tickers and phrases ("1,200 crore", "BANKNIFTY") that embeddings blur.
 * Pure.
 */

const STOPWORDS = new Set('a an and are as at be by did do does for from how in is it of on or the to was were what when which who with about than that this these those into over has have had'.split(' '))

export function tokenize(text) {
  return String(text)
    .toLowerCase()
    .replace(/(\d),(?=\d{3}\b)/g, '$1') // 1,200 -> 1200
    .split(/[^a-z0-9.%]+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ''))
    .filter((t) => t && !STOPWORDS.has(t) && (t.length > 1 || /\d/.test(t)))
}

export function keywordScore(queryTokens, text) {
  if (!queryTokens.length) return 0
  const tokens = new Set(tokenize(text))
  let hits = 0
  for (const token of new Set(queryTokens)) if (tokens.has(token)) hits += /\d/.test(token) ? 2 : 1 // numbers are the strongest exact signal
  return hits
}

const RRF_K = 60

/** candidates: [{ id, text, distance, ... }] in vector order (best first). Returns the top `topK`. */
export function hybridRank(candidates, query, { topK = 8 } = {}) {
  const queryTokens = tokenize(query)
  const keywordOrder = candidates
    .map((c, index) => ({ c, index, score: keywordScore(queryTokens, `${c.section || ''} ${c.text}`) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
  const keywordRank = new Map(keywordOrder.map((entry, rank) => [entry.c.id, entry.score > 0 ? rank : null]))
  return candidates
    .map((c, vectorRank) => {
      const kr = keywordRank.get(c.id)
      return { ...c, score: 1 / (RRF_K + vectorRank) + (kr == null ? 0 : 1 / (RRF_K + kr)) }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
}
