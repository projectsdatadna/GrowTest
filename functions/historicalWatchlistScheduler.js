/**
 * Core logic for the Historical Watchlist feature's automated refresh -
 * dispatched via Cloud Tasks (see historicalWatchlistDispatch/
 * historicalWatchlistFetchTask in functions/index.js) rather than the
 * in-process bounded-concurrency fan-out watchlistScheduler.js uses for the
 * option-chain Watchlist - each due entry gets its own task with independent
 * retries, and the queue's own `rateLimits` throttles concurrent Groww calls
 * (replacing that pattern's ENTRY_CONCURRENCY constant). Kept in its own
 * file (rather than inline in index.js) so it can be exercised directly from
 * server.js's local-only trigger-fetch route, since Cloud Tasks queues
 * aren't emulated locally.
 */

import { isWithinMarketHours } from './watchlistScheduler.js'
import { ensureCandlesFresh } from './growwHistoricalData.js'
import { ensureIndicatorFresh } from './technicalIndicators.js'
import { analyzeWithAI } from './aiAnalysisPrompt.js'
import { logAiUsage } from './aiUsageFirestoreClient.js'
import { buildHistoricalInsightPrompt } from './historicalAiInsight.js'
import {
  updateHistoricalWatchlistFetchState,
  saveHistoricalWatchlistFetchError,
  createHistoricalWatchlistNotification,
  getLatestHistoricalWatchlistAnalysis,
  saveHistoricalWatchlistAnalysis,
  createHistoricalWatchlistAnalysisNotification,
} from './historicalWatchlistFirestoreClient.js'

// A reasonable rolling refresh window per interval - wide enough that a
// fetch always has real overlap with what's already stored (so
// ensureCandlesFresh's coverage check treats most of it as already-fresh
// instead of re-fetching the whole window every tick), without being so
// wide it costs meaningfully more per fetch than needed just to pick up the
// newest candle. Mirrors DEFAULT_LOOKBACK_DAYS in
// src/components/HistoricalChartTab.jsx, duplicated here rather than shared
// - frontend (Vite/ESM) and functions/ are separate npm packages with no
// existing shared-import mechanism, same as SUPPORTED_INTERVALS's own
// frontend/backend split (functions/growwHistoricalData.js). Only goes down
// to 15minute - the Chart tab's own Interval dropdown no longer offers
// anything finer (1/2/3/5/10-minute were removed there), so nothing can
// create an entry finer than that through the UI. A pre-existing or
// directly-API-created entry with a finer interval string still works via
// the `?? fallback` in isEntryDue/processDueEntry below, just at that
// fallback's coarser cadence rather than its own literal one.
const LOOKBACK_DAYS = {
  '15minute': 7,
  '30minute': 14,
  '1hour': 30,
  '4hour': 60,
  '1day': 180,
  '1week': 365 * 2,
  '1month': 365 * 3,
}

const INTERVAL_MINUTES = {
  '15minute': 15,
  '30minute': 30,
  '1hour': 60,
  '4hour': 240,
  '1day': 24 * 60,
  '1week': 7 * 24 * 60,
  '1month': 30 * 24 * 60,
}

const INTRADAY_INTERVALS = new Set(['15minute', '30minute', '1hour', '4hour'])

// A tick firing a little early/late from its nominal schedule shouldn't
// perpetually miss or double-fire an entry - same drift-tolerant technique
// as watchlistScheduler.js's isTierDue, generalized here from fixed
// 5m/15m/75m tiers to any of the 12 supported intervals.
const DUE_TOLERANCE_MINUTES = 1

export function isEntryDue(entry, now = new Date()) {
  // Daily/weekly/monthly entries update once a day/week/month regardless of
  // "is the market open right now" - only intraday intervals skip outside
  // market hours (no point fetching a 5-minute candle at 2am).
  if (INTRADAY_INTERVALS.has(entry.interval) && !isWithinMarketHours(now)) return false
  if (!entry.lastFetchedAt) return true
  const elapsedMinutes = (now.getTime() - new Date(entry.lastFetchedAt).getTime()) / 60000
  const intervalMinutes = INTERVAL_MINUTES[entry.interval] ?? 1440
  return elapsedMinutes >= intervalMinutes - DUE_TOLERANCE_MINUTES
}

/**
 * The actual per-entry work: fetch a rolling window ending now, refresh
 * every configured indicator, run AI inference over the result, and notify
 * only if the latest candle is newer than what this entry already had on
 * its LAST run (never on the very first run - that's just establishing a
 * baseline, not "new data", so it stays silent). Comparing against the
 * stored lastFetchedCandleTimestamp makes this idempotent across Cloud
 * Tasks retries: a retry that re-runs after a partial success (candles/
 * indicators written, but the process crashed before
 * updateHistoricalWatchlistFetchState) simply recomputes the same result
 * and, seeing no timestamp advance beyond what's already stored, creates no
 * duplicate notification.
 *
 * `azureConfig` is optional - callers that don't care about AI (there are
 * none today, but nothing here requires one) can omit it and the AI step is
 * simply skipped, same shape as the per-indicator-spec isolation below.
 */
export async function processDueEntry(entry, { groww_token, azureConfig }) {
  const rangeEnd = new Date()
  const lookbackDays = LOOKBACK_DAYS[entry.interval] ?? 30
  const rangeStart = new Date(rangeEnd.getTime() - lookbackDays * 24 * 60 * 60 * 1000)

  let candles
  try {
    ;({ candles } = await ensureCandlesFresh({
      exchange: entry.exchange,
      symbol: entry.symbol,
      interval: entry.interval,
      rangeStart,
      rangeEnd,
      groww_token,
    }))
  } catch (error) {
    await saveHistoricalWatchlistFetchError(entry.id, error.message)
    throw error
  }

  // Captured (not discarded) so the AI insight step below can summarize the
  // exact same indicator data just refreshed, instead of re-fetching it.
  const indicatorSeries = {}
  for (const spec of entry.indicatorSpecs || []) {
    try {
      indicatorSeries[spec] = await ensureIndicatorFresh({ symbol: entry.symbol, exchange: entry.exchange, interval: entry.interval, spec, candles })
    } catch (error) {
      console.error(`Historical watchlist indicator error for entry ${entry.id}, spec "${spec}":`, error.message)
    }
  }

  if (candles.length === 0) return

  const latestCandleTimestamp = candles[candles.length - 1].timestamp
  const hadBaseline = entry.lastFetchedCandleTimestamp != null
  if (hadBaseline && latestCandleTimestamp > entry.lastFetchedCandleTimestamp) {
    const newCandleCount = candles.filter((c) => c.timestamp > entry.lastFetchedCandleTimestamp).length
    await createHistoricalWatchlistNotification({
      watchlistId: entry.id,
      symbol: entry.symbol,
      exchange: entry.exchange,
      interval: entry.interval,
      newCandleCount,
      latestCandleTimestamp,
    })
  }

  if (azureConfig) {
    await runAutomatedAiInsight(entry, { candles, indicatorSeries, azureConfig, latestCandleTimestamp })
  }

  await updateHistoricalWatchlistFetchState(entry.id, { lastFetchedCandleTimestamp: latestCandleTimestamp })
}

/**
 * Runs the same AI insight prompt the Chart tab's manual "AI Insight"
 * button uses (buildHistoricalInsightPrompt, historicalAiInsight.js) -
 * automatically, for this entry, on its own due-check above (no separate
 * AI-specific cadence/floor - the entry's own configured interval already
 * governs this, and 15 minutes is already the finest interval selectable in
 * the UI). Isolated in its own try/catch so an AI failure (rate limit,
 * Azure outage, JSON parse failure) never fails the candle/indicator
 * refresh that already succeeded above, and never throws back to the Cloud
 * Task - which would otherwise retry work that already succeeded.
 */
async function runAutomatedAiInsight(entry, { candles, indicatorSeries, azureConfig, latestCandleTimestamp }) {
  try {
    const previousAnalysis = await getLatestHistoricalWatchlistAnalysis(entry.id)
    const promptContent = buildHistoricalInsightPrompt({
      symbol: entry.symbol,
      exchange: entry.exchange,
      interval: entry.interval,
      candles,
      indicatorSeries,
      previousAnalysis,
    })
    const result = await analyzeWithAI(promptContent, azureConfig)
    await logAiUsage({
      feature: 'historical_watchlist_ai_insight',
      usage: result.usage,
      model: azureConfig.deployment,
      metadata: { watchlistId: entry.id, symbol: entry.symbol, exchange: entry.exchange, interval: entry.interval },
    })
    await saveHistoricalWatchlistAnalysis({
      watchlistId: entry.id,
      symbol: entry.symbol,
      exchange: entry.exchange,
      interval: entry.interval,
      parsed_analysis: result.parsed_analysis,
      raw_text: result.raw_text,
      usage: result.usage,
      candleTimestamp: latestCandleTimestamp,
    })

    // Only notify when the outlook actually changed from the entry's own
    // last automated read - never on the first-ever run (nothing to
    // compare against yet) and never when the read is unchanged, the same
    // "only notify on real new information" restraint the candle
    // notification above already applies.
    const newOutlook = result.parsed_analysis?.outlook
    const previousOutlook = previousAnalysis?.parsed_analysis?.outlook
    if (previousAnalysis && newOutlook && newOutlook !== previousOutlook) {
      await createHistoricalWatchlistAnalysisNotification({
        watchlistId: entry.id,
        symbol: entry.symbol,
        exchange: entry.exchange,
        interval: entry.interval,
        outlook: newOutlook,
        summary: result.parsed_analysis?.trend_summary || '',
      })
    }
  } catch (error) {
    console.error(`Historical watchlist AI insight error for entry ${entry.id}:`, error.message)
  }
}
