/**
 * Core logic for the Watchlist feature's server-driven tracking - runs
 * unattended via Cloud Scheduler (see the watchlistTick/watchlistCleanup
 * onSchedule exports in functions/index.js), independent of any client
 * being open. Kept in its own file (rather than inline in index.js) so it
 * can be exercised directly from a script for local testing, since there's
 * no scheduler in local dev.
 */

import { fetchFilteredOptionChain } from './growwOptionChain.js'
import { buildInstitutionalAnalysisPrompt, buildSummarizedRecommendationsPrompt, buildDifferencePrompt, analyzeWithAI } from './aiAnalysisPrompt.js'
import { logAiUsage } from './aiUsageFirestoreClient.js'
import {
  listActiveWatchlistEntries,
  saveWatchlistSnapshot,
  getLatestWatchlistSnapshot,
  findWatchlistSnapshotNear,
  saveWatchlistAnalysis,
  getLatestWatchlistAnalysis,
  saveWatchlistDifference,
  getLatestWatchlistDifference,
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

// How many watchlist entries to process at once inside one tick. Each entry
// is a Groww fetch plus at most one lightweight difference-only AI call per
// due tier now (full institutional reports moved on-demand - see
// generateWatchlistAnalysis above), so a tick is far cheaper than it used to
// be when it ran two full-report AI calls per tier, but this stays bounded
// rather than "run everything at once" to avoid bursting past Groww/Azure
// OpenAI's own concurrent-request limits as the watchlist grows.
const ENTRY_CONCURRENCY = 4

// Runs `mapper` over `items` with at most `limit` in flight at once,
// preserving each result's original index (unlike Promise.all over batches,
// a finished slot immediately picks up the next item rather than waiting for
// its whole batch to finish).
async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length)
  let nextIndex = 0

  async function worker() {
    while (true) {
      const index = nextIndex++
      if (index >= items.length) return
      results[index] = await mapper(items[index], index)
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

const TIER_MINUTES = { '15m': 15, '75m': 75 }

// A matched "previous" snapshot further than this multiple of the tier's own
// window from its target time is rejected (findWatchlistSnapshotNear returns
// null instead) rather than accepted as-is - see the comment on that function
// for why this doesn't reintroduce the fixed-tolerance bug it replaced.
const PREVIOUS_SNAPSHOT_MAX_DISTANCE_MULTIPLIER = 2

// Ticks are scheduled "every 15 minutes" but real-world dispatch drifts - so
// whether the 75m tier's difference is due is decided by real elapsed time
// since its own last automatic difference, not by assuming `now` lands on an
// exact multiple-of-75 boundary since market open. A small tolerance lets a
// tick that's due, say, 30-60s early still count.
const TIER_DUE_TOLERANCE_MINUTES = 1

async function isTierDue(watchlist_id, tier, now) {
  const latest = await getLatestWatchlistDifference(watchlist_id, tier)
  if (!latest) return true
  const elapsedSinceLastRun = (now.getTime() - new Date(latest.createdAt).getTime()) / 60000
  return elapsedSinceLastRun >= TIER_MINUTES[tier] - TIER_DUE_TOLERANCE_MINUTES
}

/**
 * On-demand: generates ONE style's AI comparison ("current" vs "previous"
 * snapshot, ~tierMinutes apart) for a watchlist entry, triggered by a user's
 * button click rather than the schedule. Deliberately runs only the
 * requested promptType - not both, unlike the old automatic behavior this
 * replaces - since running only what the user actually asked to see is the
 * entire point of moving this off the schedule (this is what actually cuts
 * token spend, not just the removal of the schedule itself). Uses whatever
 * snapshot the background fetch job (processEntry below) most recently
 * saved as "current" rather than making a fresh live Groww call - fetching
 * is that job's responsibility, not this one's.
 */
export async function generateWatchlistAnalysis({ entry, tier, promptType, azureConfig }) {
  const currentSnapshotDoc = await getLatestWatchlistSnapshot(entry.id)
  if (!currentSnapshotDoc) {
    throw new Error('No snapshot data available yet for this entry - wait for the next background fetch.')
  }

  const tierMinutes = TIER_MINUTES[tier]
  const targetTime = new Date(Date.now() - tierMinutes * 60 * 1000)
  const maxPreviousDistanceMs = tierMinutes * PREVIOUS_SNAPSHOT_MAX_DISTANCE_MULTIPLIER * 60 * 1000
  const previousDoc = await findWatchlistSnapshotNear(entry.id, targetTime, currentSnapshotDoc.id, maxPreviousDistanceMs)
  const previous = previousDoc ? { filtered_strikes: previousDoc.filtered_strikes } : null

  const current = {
    underlying_symbol: entry.underlying_symbol,
    exchange: entry.exchange,
    expiry_date: entry.expiry_date,
    points_range: entry.points_range,
    filtered_strikes: currentSnapshotDoc.filtered_strikes,
  }

  const isSummarized = promptType === 'summarized_recommendations'
  const buildPrompt = isSummarized ? buildSummarizedRecommendationsPrompt : buildInstitutionalAnalysisPrompt
  const feature = isSummarized ? 'watchlist_summarized_recommendations' : 'watchlist_master_prompt'

  // Same "read the previous report before writing the new one" ordering
  // analyzeTier used to use, and for the same reason: this call's own
  // saveWatchlistAnalysis below would otherwise become "the previous one" to
  // itself if read afterward.
  const [result, previousAnalysisDoc] = await Promise.all([
    analyzeWithAI(buildPrompt(current, previous), azureConfig),
    getLatestWatchlistAnalysis(entry.id, tier),
  ])
  await logAiUsage({
    feature,
    usage: result.usage,
    model: azureConfig.deployment,
    metadata: { watchlist_id: entry.id, tier, underlying_symbol: entry.underlying_symbol },
  })

  await saveWatchlistAnalysis({
    watchlist_id: entry.id,
    tier,
    current_snapshot_id: currentSnapshotDoc.id,
    previous_snapshot_id: previousDoc?.id || null,
    underlying_ltp: currentSnapshotDoc.underlying_ltp,
    master_prompt_analysis: isSummarized ? null : result.parsed_analysis,
    summarized_recommendations_analysis: isSummarized ? result.parsed_analysis : null,
    current_snapshot: {
      underlying_ltp: currentSnapshotDoc.underlying_ltp,
      filtered_strikes: currentSnapshotDoc.filtered_strikes,
      fetched_at: currentSnapshotDoc.createdAt,
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

  return getLatestWatchlistAnalysis(entry.id, tier)
}

/**
 * Automatic: generates the lightweight Difference-column comparison for one
 * tier, run from the background tick itself (unlike generateWatchlistAnalysis
 * above, which only ever runs on demand). Uses buildDifferencePrompt - a
 * single, small comparison-only call, not the two full institutional-report
 * prompts the old automatic behavior used to run - so this is still a large
 * reduction in automatic AI spend even though some automatic AI is back.
 * Skips the AI call entirely (and writes nothing) when there's no previous
 * snapshot yet to compare against - nothing to diff on an entry's first tick
 * of the day.
 */
async function generateDifferenceForTier({ entry, tier, currentSnapshot, currentSnapshotId, now, azureConfig }) {
  const tierMinutes = TIER_MINUTES[tier]
  const targetTime = new Date(now.getTime() - tierMinutes * 60 * 1000)
  const maxPreviousDistanceMs = tierMinutes * PREVIOUS_SNAPSHOT_MAX_DISTANCE_MULTIPLIER * 60 * 1000
  const previousDoc = await findWatchlistSnapshotNear(entry.id, targetTime, currentSnapshotId, maxPreviousDistanceMs)
  if (!previousDoc) return

  const current = {
    underlying_symbol: entry.underlying_symbol,
    exchange: entry.exchange,
    expiry_date: entry.expiry_date,
    points_range: entry.points_range,
    filtered_strikes: currentSnapshot.filtered_strikes,
  }
  const previous = { filtered_strikes: previousDoc.filtered_strikes, points_range: entry.points_range }

  const result = await analyzeWithAI(buildDifferencePrompt(current, previous), azureConfig)
  await logAiUsage({
    feature: 'watchlist_difference',
    usage: result.usage,
    model: azureConfig.deployment,
    metadata: { watchlist_id: entry.id, tier, underlying_symbol: entry.underlying_symbol },
  })

  await saveWatchlistDifference({
    watchlist_id: entry.id,
    tier,
    current_snapshot_id: currentSnapshotId,
    previous_snapshot_id: previousDoc.id,
    underlying_ltp: currentSnapshot.underlying_ltp,
    difference_analysis: result.parsed_analysis ? { available: true, ...result.parsed_analysis } : null,
    current_snapshot: {
      underlying_ltp: currentSnapshot.underlying_ltp,
      filtered_strikes: currentSnapshot.filtered_strikes,
      fetched_at: now.toISOString(),
    },
    previous_snapshot: {
      underlying_ltp: previousDoc.underlying_ltp,
      filtered_strikes: previousDoc.filtered_strikes,
      fetched_at: previousDoc.createdAt,
    },
  })
}

/**
 * Runs one entry's full tick: Groww fetch, save the raw snapshot, then the
 * lightweight automatic Difference comparison for whichever tiers are due
 * (15m every tick, 75m when isTierDue says so). The full institutional
 * reports (generateWatchlistAnalysis above) stay on-demand only. Called
 * through mapWithConcurrency below, so several entries are in flight at
 * once - each still gets its own `now`, captured right here rather than
 * reusing the tick-wide one, same reasoning as before this file's automatic
 * AI was removed and now reinstated in this lighter form: an entry near the
 * end of a longer watchlist can still start its turn a couple of minutes
 * after the tick began.
 */
async function processEntry(entry, { groww_token, azureConfig }) {
  const now = new Date()
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

    const tiersToRun = ['15m']
    if (await isTierDue(entry.id, '75m', now)) tiersToRun.push('75m')

    // allSettled so one tier timing out doesn't take its siblings down with
    // it, and a difference failure never fails the snapshot fetch/save that
    // already succeeded above.
    const tierOutcomes = await Promise.allSettled(
      tiersToRun.map((tier) => generateDifferenceForTier({ entry, tier, currentSnapshot, currentSnapshotId, now, azureConfig }))
    )
    const failedTiers = []
    tierOutcomes.forEach((outcome, i) => {
      if (outcome.status === 'rejected') {
        const tier = tiersToRun[i]
        console.error(`Watchlist tick: ${tier} difference failed for ${entry.underlying_symbol} (${entry.id}):`, outcome.reason?.message)
        failedTiers.push(tier)
      }
    })

    return {
      watchlist_id: entry.id,
      underlying_symbol: entry.underlying_symbol,
      tiers: tiersToRun,
      status: failedTiers.length ? 'partial' : 'ok',
      ...(failedTiers.length ? { failedTiers } : {}),
    }
  } catch (error) {
    console.error(`Watchlist tick failed for ${entry.underlying_symbol} (${entry.id}):`, error.message)
    return { watchlist_id: entry.id, underlying_symbol: entry.underlying_symbol, status: 'error', error: error.message }
  }
}

/**
 * The 15-minute tick: fetches fresh data for every active watchlist entry
 * and refreshes the Difference column for the 15-min tier, plus the 75-min
 * tier whenever it's due (see isTierDue). Full institutional reports stay
 * on-demand only (see generateWatchlistAnalysis). Entries are processed with
 * bounded concurrency (see ENTRY_CONCURRENCY) rather than one at a time, so
 * total tick duration doesn't scale linearly with watchlist size.
 */
export async function runWatchlistTick({ groww_token, azureConfig, now = new Date() }) {
  if (!isWithinMarketHours(now)) {
    return { skipped: true, reason: 'outside market hours' }
  }

  const elapsedMinutes = minutesSinceMarketOpen(now)
  const entries = await listActiveWatchlistEntries()

  const results = await mapWithConcurrency(entries, ENTRY_CONCURRENCY, (entry) => processEntry(entry, { groww_token, azureConfig }))

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

/** Wipes the day's fetched snapshots, analyses, and differences - the watchlist config itself is untouched. */
export async function runWatchlistCleanup() {
  const deletedSnapshots = await deleteAllDocsInCollection('watchlistSnapshots')
  const deletedAnalyses = await deleteAllDocsInCollection('watchlistAnalyses')
  const deletedDifferences = await deleteAllDocsInCollection('watchlistDifferences')
  return { deletedSnapshots, deletedAnalyses, deletedDifferences }
}
