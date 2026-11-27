/**
 * Shared formatting + browser-alert helpers for crossover alerts - used by the
 * header bell (AppShell) and the Crossover Scanner tab.
 */

// Timeframes the scanner runs on, in display order. Mirrors
// functions/crossoverTimeframes.js (frontend and functions/ share no code).
export const TIMEFRAME_ORDER = ['15minute', '1hour', '4hour', '1day', '1week']
export const TIMEFRAME_LABELS = {
  '15minute': '15 min',
  '1hour': '1 hour',
  '4hour': '4 hour',
  '1day': 'Daily',
  '1week': 'Weekly',
}

export function timeframeLabel(interval) {
  return TIMEFRAME_LABELS[interval] || interval || 'System'
}

export function timeAgo(isoString) {
  if (!isoString) return ''
  const diffMs = Date.now() - new Date(isoString).getTime()
  const minutes = Math.floor(diffMs / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

// Candle timestamps are epoch seconds; bars are always shown in IST.
export function formatCandleTime(timestampSeconds) {
  if (!timestampSeconds) return ''
  return new Date(timestampSeconds * 1000).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

// The time a crossover is SHOWN at. The scanner can only evaluate a bar once it
// closes (the 09:15 bar is processed at 09:30), but 15-minute crossovers are
// labelled with the bar's START (09:15) - the interval they belong to. The other
// timeframes show the moment the bar CLOSED (Groww labels a 4-hour bar "08:00" and
// a 1-hour bar "11:00", which are odd-aligned start times), never the time the
// scanner stored the alert. Mirrors displayedTime() / candleEnd() in
// functions/crossoverTimeframes.js.
export const START_LABELLED_INTERVALS = ['15minute']
const IST_OFFSET_SECONDS = 5.5 * 3600
const DAY_SECONDS = 86400
const MARKET_CLOSE_OFFSET = 15 * 3600 + 30 * 60 // 15:30 IST, seconds after IST midnight
const INTRADAY_SECONDS = { '15minute': 900, '1hour': 3600, '4hour': 14400 }

export function crossoverTimestamp(n) {
  const start = n?.candleTimestamp
  if (!start) return 0
  if (START_LABELLED_INTERVALS.includes(n.interval)) return start
  const daysSinceEpoch = Math.floor((start + IST_OFFSET_SECONDS) / DAY_SECONDS)
  const dayStart = daysSinceEpoch * DAY_SECONDS - IST_OFFSET_SECONDS
  const close = dayStart + MARKET_CLOSE_OFFSET
  if (INTRADAY_SECONDS[n.interval]) return Math.min(start + INTRADAY_SECONDS[n.interval], close)
  if (n.interval === '1day') return close
  if (n.interval === '1week') {
    const weekday = (daysSinceEpoch + 4) % 7 // 0 = Sunday ... 6 = Saturday (1970-01-01 was a Thursday)
    return dayStart - ((weekday + 6) % 7) * DAY_SECONDS + 4 * DAY_SECONDS + MARKET_CLOSE_OFFSET
  }
  return start
}

// A bar's close time -> the time to show for it (start for START_LABELLED_INTERVALS).
// For fields that only carry the bar end, e.g. the scanner's lastBarEnd.
export function displayedBarTime(interval, barEnd) {
  if (!barEnd) return 0
  return START_LABELLED_INTERVALS.includes(interval) ? barEnd - INTRADAY_SECONDS[interval] : barEnd
}

// "05 Nov, 12:00 IST"
export function formatCrossoverTime(n) {
  const timestamp = crossoverTimestamp(n)
  return timestamp ? `${formatCandleTime(timestamp)} IST` : ''
}

// {MACD: 1.42, Signal: 1.31} -> "MACD 1.42 · Signal 1.31"
export function formatLines(lines) {
  return Object.entries(lines || {})
    .map(([name, value]) => `${name} ${value}`)
    .join(' · ')
}

// 'unsupported' | 'default' | 'granted' | 'denied'
export function getNotificationPermission() {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported'
  return Notification.permission
}

// Must be called from a user click - browsers ignore (or penalize) permission
// prompts that fire on page load.
export async function requestNotificationPermission() {
  if (getNotificationPermission() === 'unsupported') return 'unsupported'
  try {
    return await Notification.requestPermission()
  } catch {
    return getNotificationPermission()
  }
}

// Native browser/OS notification. A no-op (never throws) when unsupported or
// not permitted, so the in-app popup is always the guaranteed channel.
export function showBrowserNotification({ title, body, tag }) {
  if (getNotificationPermission() !== 'granted') return
  try {
    const notification = new Notification(title, { body, tag, renotify: true })
    notification.onclick = () => {
      window.focus()
      notification.close()
    }
  } catch (error) {
    console.error('Browser notification failed:', error)
  }
}

// Short two-tone beep. Browsers block audio until the page has had a user
// gesture - in that case this silently does nothing.
export function playAlertBeep() {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext
    if (!AudioContextClass) return
    const context = new AudioContextClass()
    if (context.state === 'suspended') {
      context.close()
      return
    }
    const gain = context.createGain()
    gain.gain.value = 0.06
    gain.connect(context.destination)
    ;[880, 660].forEach((frequency, i) => {
      const oscillator = context.createOscillator()
      oscillator.frequency.value = frequency
      oscillator.connect(gain)
      oscillator.start(context.currentTime + i * 0.16)
      oscillator.stop(context.currentTime + i * 0.16 + 0.12)
    })
    setTimeout(() => context.close(), 600)
  } catch {
    // audio is best-effort only
  }
}
