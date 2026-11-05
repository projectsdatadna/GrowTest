/**
 * Shared formatting + browser-alert helpers for crossover alerts - used by the
 * header bell (AppShell), the popup (CrossoverAlertPopup) and the Crossover
 * Scanner tab. Kept out of AppShell.jsx because AppShell mounts the popup;
 * the popup importing back from AppShell would be a circular import.
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
