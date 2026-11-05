/**
 * Shared rendering of one notification's content, used by the header bell
 * dropdown and the Notifications page so every notification type looks the
 * same in both. A notification document predating the `type` field is a
 * 'candles' notification (its original, only shape).
 */

import { formatCrossoverTime, formatLines, timeframeLabel } from './crossoverFormat'

export function notificationType(n) {
  return n.type || 'candles'
}

export function DirectionBadge({ direction }) {
  return direction === 'bullish' ? <span className="text-bullish font-semibold">▲ Bullish</span> : <span className="text-bearish font-semibold">▼ Bearish</span>
}

// Title line: what/where the notification is about.
export function notificationTitle(n) {
  if (notificationType(n) === 'scanner_warning') return 'Crossover scanner'
  return `${n.symbol}${n.interval ? ` · ${timeframeLabel(n.interval)}` : ''}`
}

export function NotificationBody({ n }) {
  const type = notificationType(n)

  if (type === 'scanner_warning') {
    return <span className="text-bearish">{n.message}</span>
  }

  if (type === 'crossover') {
    return (
      <div className="flex flex-col gap-[2px]">
        <div>
          <DirectionBadge direction={n.direction} /> <span className="text-on-surface">{n.indicatorLabel}</span>
        </div>
        <div>
          Close ₹{n.closePrice} · Crossed {formatCrossoverTime(n)}
        </div>
        <div>{formatLines(n.lines)}</div>
        {n.confluence?.length > 0 && <div>Also crossed: {n.confluence.join(', ')}</div>}
      </div>
    )
  }

  if (type === 'analysis') {
    return (
      <>
        AI insight: <span className={n.outlook === 'bullish' ? 'text-bullish' : n.outlook === 'bearish' ? 'text-bearish' : ''}>{n.outlook}</span>
        {n.summary ? ` — ${n.summary}` : ''}
      </>
    )
  }

  return (
    <>
      {n.newCandleCount} new candle{n.newCandleCount === 1 ? '' : 's'}
    </>
  )
}
