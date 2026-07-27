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
  getLatestWatchlistAnalysis,
  saveWatchlistFetchError,
  clearWatchlistFetchError,
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

// Ticks are scheduled "every 5 minutes" but real-world dispatch drifts
// (observed ~6 minutes apart in production, since each tick's own AI calls
// take 80-90+ seconds) - so whether a 15m/75m tier is due is decided by real
// elapsed time since that tier's own last analysis, not by assuming `now`
// lands on an exact multiple-of-15/75 boundary since market open (that
// modulo check silently never fired once the schedule drifted off a clean
// 5-minute grid, so those tiers never got any data at all). A small
// tolerance lets a tick that's due, say, 30-60s early still count.
const TIER_DUE_TOLERANCE_MINUTES = 1

async function isTierDue(watchlist_id, tier, now) {
  const latest = await getLatestWatchlistAnalysis(watchlist_id, tier)
  if (!latest) return true
  const elapsedSinceLastRun = (now.getTime() - new Date(latest.createdAt).getTime()) / 60000
  return elapsedSinceLastRun >= TIER_MINUTES[tier] - TIER_DUE_TOLERANCE_MINUTES
}

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
 * they're due (see isTierDue) for that entry. One Groww fetch per entry
 * serves all three tiers - no redundant fetching.
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
      let chain
      try {
        chain = await fetchFilteredOptionChain({
          exchange: entry.exchange,
          underlying_symbol: entry.underlying_symbol,
          expiry_date: entry.expiry_date,
          points_range: entry.points_range,
          groww_token,
        })
      } catch (error) {
        // Persist the real Groww error (error.details, when present, carries
        // Groww's own raw response body) so GET /watchlist/:id/analysis/:tier
        // can surface it instead of silently returning stale/null analysis.
        await saveWatchlistFetchError(entry.id, { ...(error.details || { error: error.message }), occurred_at: now.toISOString() })
        throw error
      }
      await clearWatchlistFetchError(entry.id)

      const currentSnapshotId = await saveWatchlistSnapshot({
        watchlist_id: entry.id,
        underlying_ltp: chain.underlying_ltp,
        filtered_strikes: chain.filtered_strikes,
      })
      const currentSnapshot = { underlying_ltp: chain.underlying_ltp, filtered_strikes: chain.filtered_strikes }

      const tiersToRun = ['5m']
      if (await isTierDue(entry.id, '15m', now)) tiersToRun.push('15m')
      if (await isTierDue(entry.id, '75m', now)) tiersToRun.push('75m')

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

/**
 * Stamps every active entry with a "no Groww access token available" error -
 * used when getGrowwAccessToken() itself fails, before runWatchlistTick ever
 * gets to process a single entry (so nothing would otherwise record why).
 */
export async function recordGrowwAuthFailure(error, now = new Date()) {
  const entries = await listActiveWatchlistEntries()
  const details = { error: 'No Groww access token available', message: error.message, occurred_at: now.toISOString() }
  await Promise.all(entries.map((entry) => saveWatchlistFetchError(entry.id, details)))
}

/** Wipes the day's fetched snapshots and analyses - the watchlist config itself is untouched. */
export async function runWatchlistCleanup() {
  const deletedSnapshots = await deleteAllDocsInCollection('watchlistSnapshots')
  const deletedAnalyses = await deleteAllDocsInCollection('watchlistAnalyses')
  return { deletedSnapshots, deletedAnalyses }
}
