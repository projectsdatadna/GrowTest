/**
 * One merged crossover card on the Notifications page: every indicator that
 * crossed for one symbol on one bar of one timeframe (a `crossoverGroups` doc,
 * see functions/crossoverScanner.js buildCrossoverGroups). Stars = how many
 * distinct indicators crossed - the more, the more important. The right-hand
 * column shows the ADX (trend strength) at that bar vs the bar before, in plain
 * text with no colour cues.
 */

import { DirectionBadge } from './NotificationContent'
import { CardChartButton } from './CardChartHover'
import { formatCrossoverTime, formatLines, timeframeLabel } from './crossoverFormat'

// Crossover indicators the scanner runs (CROSSOVER_SPECS) - the star scale.
export const MAX_STARS = 7

const ADX_STATUS = { increase: 'Increased', decrease: 'Decreased', flat: 'Flat' }

export function StarRating({ count, max = MAX_STARS }) {
  return (
    <span className="flex items-center" title={`${count} of ${max} indicators crossed`} aria-label={`${count} of ${max} indicators crossed`}>
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className="material-symbols-outlined text-[14px] text-amber-400" style={{ fontVariationSettings: "'FILL' 1" }} aria-hidden="true">
          star
        </span>
      ))}
      <span className="text-[10px] text-on-surface-variant ml-[2px] font-mono">
        {count}/{max}
      </span>
    </span>
  )
}

// Plain text only (no green/red): Current, Previous, Status.
export function AdxColumn({ adx }) {
  const row = (label, value) => (
    <div className="flex justify-between gap-sm">
      <span>{label}</span>
      <span className="font-mono text-on-surface">{value}</span>
    </div>
  )
  return (
    <div className="text-xs text-on-surface-variant md:w-40 md:shrink-0 md:border-l border-t md:border-t-0 border-outline-variant pt-xs md:pt-0 md:pl-sm flex flex-col gap-[2px]">
      <div className="text-[11px] uppercase tracking-wide">ADX ({adx?.period || 14})</div>
      {row('Current', adx ? adx.value.toFixed(2) : '—')}
      {row('Previous', adx ? adx.prev.toFixed(2) : '—')}
      {row('Status', adx ? ADX_STATUS[adx.trend] : '—')}
    </div>
  )
}

export default function CrossoverGroupCard({ group, isRead, onOpen, chartHover }) {
  return (
    <div
      onClick={() => !isRead && onOpen(group)}
      className={`px-sm py-xs rounded-lg text-sm flex flex-col md:grid md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] gap-sm ${isRead ? 'text-on-surface-variant' : 'text-on-surface bg-surface-container-highest cursor-pointer'}`}
    >
      <div className="flex-1 min-w-0 flex flex-col gap-[2px]">
        <div className="flex items-center justify-between gap-sm flex-wrap">
          <span className="font-medium flex items-center gap-xs flex-wrap">
            {!isRead && <span className="w-2 h-2 rounded-full bg-primary inline-block" aria-label="unread" />}
            {group.symbol} · {timeframeLabel(group.interval)}
            {group.isIndex && <span className="text-[10px] px-xs rounded border border-outline-variant text-on-surface-variant">INDEX</span>}
            <StarRating count={group.stars} />
            <span className="text-[11px] font-mono">
              <span className="text-bullish">▲{group.bullishCount}</span> <span className="text-bearish">▼{group.bearishCount}</span>
            </span>
          </span>
          <span className="text-[10px] text-on-surface-variant">{formatCrossoverTime(group)}</span>
        </div>
        <ul className="text-xs text-on-surface-variant flex flex-col gap-[2px]">
          {group.indicators.map((indicator) => (
            <li key={`${indicator.label}-${indicator.direction}`} className="flex flex-wrap gap-x-sm">
              <DirectionBadge direction={indicator.direction} />
              <span className="text-on-surface">{indicator.label}</span>
              <span>{formatLines(indicator.lines)}</span>
            </li>
          ))}
        </ul>
        <div className="text-xs text-on-surface-variant">Close ₹{group.closePrice}</div>
      </div>
      {/* middle column = the centre of the card */}
      <div className="flex items-center justify-center">{chartHover && <CardChartButton group={group} hover={chartHover} />}</div>
      <div className="md:justify-self-end">
        <AdxColumn adx={group.adx} />
      </div>
    </div>
  )
}
