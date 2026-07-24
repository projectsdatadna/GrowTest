/**
 * Core logic for the Watchlist feature's server-driven tracking - runs
 * unattended via Cloud Scheduler (see the watchlistTick/watchlistCleanup
 * onSchedule exports in functions/index.js), independent of any client
 * being open. Kept in its own file (rather than inline in index.js) so it
 * can be exercised directly from a script for local testing, since there's
 * no scheduler in local dev.
 */

import { fetchFilteredOptionChain } from './growwOptionChain.js'
import { buildInstitutionalAnalysisPrompt, buildSummarizedRecommendationsPrompt, analyzeWithAI } from './aiAnalysisPrompt.js'
import {
  listActiveWatchlistEntries,
  saveWatchlistSnapshot,
  findWatchlistSnapshotNear,
  saveWatchlistAnalysis,
  getWatchlistAnalysisBySnapshotId,
  deleteAllDocsInCollection,
} from './watchlistFirestoreClient.js'

const MARKET_OPEN_MINUTES = 9 * 60 + 15 // 9:15 IST
const MARKET_CLOSE_MINUTES = 15 * 60 + 30 // 15:30 IST
const TRADING_WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']

function getIstParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date)
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]))
  return { weekday: map.weekday, hour: parseInt(map.hour, 10) % 24, minute: parseInt(map.minute, 10) }
}

export function isWithinMarketHours(date = new Date()) {
  const { weekday, hour, minute } = getIstParts(date)
  if (!TRADING_WEEKDAYS.includes(weekday)) return false
  const minutesNow = hour * 60 + minute
  return minutesNow >= MARKET_OPEN_MINUTES && minutesNow <= MARKET_CLOSE_MINUTES
}

export function minutesSinceMarketOpen(date = new Date()) {
  const { hour, minute } = getIstParts(date)
  return hour * 60 + minute - MARKET_OPEN_MINUTES
}

const TIER_MINUTES = { '5m': 5, '15m': 15, '75m': 75 }

/**
 * Runs one tier's comparison+analysis for a single watchlist entry: finds
 * the snapshot from ~tierMinutes ago (null if none exists yet, e.g. the
 * first few ticks of the day), runs both prompts with (current, previous),
 * and persists the result. Both AI calls run concurrently.
 */
async function analyzeTier({ entry, tier, currentSnapshot, currentSnapshotId, now, azureConfig }) {
  const tierMinutes = TIER_MINUTES[tier]
  const targetTime = new Date(now.getTime() - tierMinutes * 60 * 1000)
  const previousDoc = await findWatchlistSnapshotNear(entry.id, targetTime)
  const previous = previousDoc ? { filtered_strikes: previousDoc.filtered_strikes } : null

  const current = {
    underlying_symbol: entry.underlying_symbol,
    exchange: entry.exchange,
    expiry_date: entry.expiry_date,
    points_range: entry.points_range,
    filtered_strikes: currentSnapshot.filtered_strikes,
  }

  const [masterResult, summarizedResult, previousAnalysisDoc] = await Promise.all([
    analyzeWithAI(buildInstitutionalAnalysisPrompt(current, previous), azureConfig),
    analyzeWithAI(buildSummarizedRecommendationsPrompt(current, previous), azureConfig),
    previousDoc ? getWatchlistAnalysisBySnapshotId(entry.id, tier, previousDoc.id) : null,
  ])

  await saveWatchlistAnalysis({
    watchlist_id: entry.id,
    tier,
    current_snapshot_id: currentSnapshotId,
    previous_snapshot_id: previousDoc?.id || null,
    underlying_ltp: currentSnapshot.underlying_ltp,
    master_prompt_analysis: masterResult.parsed_analysis,
    summarized_recommendations_analysis: summarizedResult.parsed_analysis,
    current_snapshot: {
      underlying_ltp: currentSnapshot.underlying_ltp,
      filtered_strikes: currentSnapshot.filtered_strikes,
      fetched_at: now.toISOString(),
    },
    previous_snapshot: previousDoc
      ? {
          underlying_ltp: previousDoc.underlying_ltp,
          filtered_strikes: previousDoc.filtered_strikes,
          fetched_at: previousDoc.createdAt,
        }
      : null,
    previous_master_prompt_analysis: previousAnalysisDoc?.master_prompt_analysis || null,
    previous_summarized_recommendations_analysis: previousAnalysisDoc?.summarized_recommendations_analysis || null,
  })
}

/**
 * The 5-minute tick: fetches fresh data for every active watchlist entry
 * and always runs the 5-min tier, plus the 15-min/75-min tiers whenever
 * `now` lands on their respective boundary since market open. One Groww
 * fetch per entry serves all three tiers - no redundant fetching.
 */
export async function runWatchlistTick({ groww_token, azureConfig, now = new Date() }) {
  if (!isWithinMarketHours(now)) {
    return { skipped: true, reason: 'outside market hours' }
  }

  const elapsedMinutes = minutesSinceMarketOpen(now)
  const entries = await listActiveWatchlistEntries()
  const results = []

  for (const entry of entries) {
    try {
      const chain = await fetchFilteredOptionChain({
        exchange: entry.exchange,
        underlying_symbol: entry.underlying_symbol,
        expiry_date: entry.expiry_date,
        points_range: entry.points_range,
        groww_token,
      })
      const currentSnapshotId = await saveWatchlistSnapshot({
        watchlist_id: entry.id,
        underlying_ltp: chain.underlying_ltp,
        filtered_strikes: chain.filtered_strikes,
      })
      const currentSnapshot = { underlying_ltp: chain.underlying_ltp, filtered_strikes: chain.filtered_strikes }

      const tiersToRun = ['5m']
      if (elapsedMinutes >= 0 && elapsedMinutes % 15 === 0) tiersToRun.push('15m')
      if (elapsedMinutes >= 0 && elapsedMinutes % 75 === 0) tiersToRun.push('75m')

      for (const tier of tiersToRun) {
        await analyzeTier({ entry, tier, currentSnapshot, currentSnapshotId, now, azureConfig })
      }

      results.push({ watchlist_id: entry.id, underlying_symbol: entry.underlying_symbol, tiers: tiersToRun, status: 'ok' })
    } catch (error) {
      console.error(`Watchlist tick failed for ${entry.underlying_symbol} (${entry.id}):`, error.message)
      results.push({ watchlist_id: entry.id, underlying_symbol: entry.underlying_symbol, status: 'error', error: error.message })
    }
  }

  return { skipped: false, elapsedMinutes, results }
}

/** Wipes the day's fetched snapshots and analyses - the watchlist config itself is untouched. */
export async function runWatchlistCleanup() {
  const deletedSnapshots = await deleteAllDocsInCollection('watchlistSnapshots')
  const deletedAnalyses = await deleteAllDocsInCollection('watchlistAnalyses')
  return { deletedSnapshots, deletedAnalyses }
}
