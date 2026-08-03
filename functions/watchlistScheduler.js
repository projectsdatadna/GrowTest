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

// How many watchlist entries to process at once inside one tick. Entries used
// to be processed strictly one at a time; with a Groww fetch plus two ~80-90s
// AI calls per due tier, that scales linearly with entry count and, past
// roughly a handful of entries, a single tick's real wall-clock duration
// blows past both the 5-minute schedule and the 540s function timeout. A
// later-queued entry then gets processed many real minutes after earlier
// ones despite every entry sharing the same nominal tick `now` - which is
// exactly what produced 5m/15m/75m all resolving to the same "previous"
// snapshot for entries near the end of an 11-entry watchlist. Kept
// conservative (not "run everything at once") to avoid bursting past
// Groww/Azure OpenAI's own concurrent-request limits - raise it if the
// watchlist grows enough that ticks are still running long with this.
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

const TIER_MINUTES = { '5m': 5, '15m': 15, '75m': 75 }

// A matched "previous" snapshot further than this multiple of the tier's own
// window from its target time is rejected (findWatchlistSnapshotNear returns
// null instead) rather than accepted as-is - see the comment on that function
// for why this doesn't reintroduce the fixed-tolerance bug it replaced.
const PREVIOUS_SNAPSHOT_MAX_DISTANCE_MULTIPLIER = 2

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
  const maxPreviousDistanceMs = tierMinutes * PREVIOUS_SNAPSHOT_MAX_DISTANCE_MULTIPLIER * 60 * 1000
  const previousDoc = await findWatchlistSnapshotNear(entry.id, targetTime, currentSnapshotId, maxPreviousDistanceMs)
  const previous = previousDoc ? { filtered_strikes: previousDoc.filtered_strikes } : null

  const current = {
    underlying_symbol: entry.underlying_symbol,
    exchange: entry.exchange,
    expiry_date: entry.expiry_date,
    points_range: entry.points_range,
    filtered_strikes: currentSnapshot.filtered_strikes,
  }

  // The previous tier report is simply whatever this tier's own last saved
  // analysis was - independent of which raw snapshot `previousDoc` above
  // happens to be. Coupling the two (finding the analysis doc whose own
  // current_snapshot_id matched previousDoc.id) broke intermittently: 15m/75m
  // only run occasionally, so their own historical current_snapshot_ids are
  // sparse and frequently don't include whichever raw snapshot is closest in
  // time on a given tick - and even 5m could miss if the prior tick's own
  // analysis had failed while its raw snapshot still saved. Read here, before
  // this tick's own saveWatchlistAnalysis call below, so it naturally returns
  // whatever preceded this new one.
  const [masterResult, summarizedResult, previousAnalysisDoc] = await Promise.all([
    analyzeWithAI(buildInstitutionalAnalysisPrompt(current, previous), azureConfig),
    analyzeWithAI(buildSummarizedRecommendationsPrompt(current, previous), azureConfig),
    getLatestWatchlistAnalysis(entry.id, tier),
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
 * Runs one entry's full tick: Groww fetch, then its due tiers. Called through
 * mapWithConcurrency below, so several entries are in flight at once - each
 * still gets its own `now`, captured right here rather than reusing the
 * tick-wide one, since with concurrency 4 an entry near the end of a longer
 * watchlist can still start its turn a couple of minutes after the tick
 * began. Without its own real timestamp, that entry's targetTime/isTierDue
 * math and its current_snapshot.fetched_at would silently drift out of sync
 * with when its data was actually fetched - the direct cause of "previous"
 * snapshots showing up dated after their own tier's "current" snapshot.
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

    const tiersToRun = ['5m']
    if (await isTierDue(entry.id, '15m', now)) tiersToRun.push('15m')
    if (await isTierDue(entry.id, '75m', now)) tiersToRun.push('75m')

    // Independent per tier (each only needs currentSnapshot, already fetched
    // above) - allSettled so one tier timing out doesn't take its siblings
    // down with it. Previously a sequential for-loop meant a single slow/
    // failed tier silently skipped every tier after it for that entry, for
    // that whole tick - the direct cause of sporadic analysis:null.
    const tierOutcomes = await Promise.allSettled(
      tiersToRun.map((tier) => analyzeTier({ entry, tier, currentSnapshot, currentSnapshotId, now, azureConfig }))
    )
    const failedTiers = []
    tierOutcomes.forEach((outcome, i) => {
      if (outcome.status === 'rejected') {
        const tier = tiersToRun[i]
        console.error(`Watchlist tick: ${tier} analysis failed for ${entry.underlying_symbol} (${entry.id}):`, outcome.reason?.message)
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
 * The 5-minute tick: fetches fresh data for every active watchlist entry
 * and always runs the 5-min tier, plus the 15-min/75-min tiers whenever
 * they're due (see isTierDue) for that entry. One Groww fetch per entry
 * serves all three tiers - no redundant fetching. Entries are processed with
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

/** Wipes the day's fetched snapshots and analyses - the watchlist config itself is untouched. */
export async function runWatchlistCleanup() {
  const deletedSnapshots = await deleteAllDocsInCollection('watchlistSnapshots')
  const deletedAnalyses = await deleteAllDocsInCollection('watchlistAnalyses')
  return { deletedSnapshots, deletedAnalyses }
}
