/**
 * One merged crossover card on the Notifications page: every indicator that
 * crossed for one symbol on one bar of one timeframe (a `crossoverGroups` doc,
 * see functions/crossoverScanner.js buildCrossoverGroups). Stars = how many
 * distinct indicators crossed - the more, the more important. The right-hand
 * columns show the symbol's NRML margin and the ADX (trend strength) at that bar vs
 * the bar before, in plain text with no colour cues. When the user entered Stoploss /
 * Target amounts on the tab, one compact line with the suggested values closes the card.
 */

import { DirectionBadge } from './NotificationContent'
import { CardChartButton } from './CardChartHover'
import { OptionChainButton } from './OptionChainHover'
import { formatCrossoverTime, formatLines, timeframeLabel } from './crossoverFormat'
import { computeStopTarget, pickStockPrice } from './stopTargetCalc'

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

// NRML margin of the symbol (edited on the Crossover Scanner page); "-" when none is saved.
export function MarginColumn({ margin }) {
  const has = typeof margin === 'number' && Number.isFinite(margin)
  return (
    <div className="text-xs text-on-surface-variant md:w-28 md:shrink-0 md:border-l border-t md:border-t-0 border-outline-variant pt-xs md:pt-0 md:pl-sm flex flex-col gap-[2px]">
      <div className="text-[11px] uppercase tracking-wide">NRML margin</div>
      <div className="font-mono text-on-surface" title={has ? `NRML margin ₹${margin}` : 'No NRML margin saved - add it on the Crossover Scanner page'}>
        {has ? `₹${margin.toLocaleString('en-IN')}` : '-'}
      </div>
    </div>
  )
}

const PRICE_SOURCE = { live: 'Live quote', sheet: 'Price from the uploaded sheet (no live quote yet)', close: 'Bar close (no live quote or sheet price)' }

// Suggested Stoploss / Target for the ₹ amounts entered on the Notifications tab (formulas in
// stopTargetCalc.js, same as the Stp & Target sheet). Lot size comes from the uploaded symbol sheet; the
// price is the live quote when there is one. One compact line across the bottom of the card (not a column),
// so it does not squeeze the indicators; only the pairs that can be computed are shown.
export function StopTargetRow({ group, quote, slAmount, targetAmount }) {
  const { price, source } = pickStockPrice({ quote, sheetPrice: group.sheetPrice, closePrice: group.closePrice })
  const lotSize = group.lotSize ?? null
  const calc = computeStopTarget({ slAmount, targetAmount, lotSize, price })
  const num = (value) => value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const row = 'md:col-span-full border-t border-outline-variant pt-xs flex flex-wrap items-baseline gap-x-lg gap-y-[2px] text-[11px] text-on-surface-variant'
  if (lotSize == null) return <div className={row}>No lot size for {group.symbol} — upload the lot size sheet</div>
  const pair = (label, value, pct, title) => (
    <span key={label} title={title}>
      {label} <span className="font-mono text-on-surface">{value}</span>
      {pct != null && <span className="font-mono"> ({num(pct)}%)</span>}
    </span>
  )
  return (
    <div className={row} aria-label="Suggested stoploss and target">
      {pair('Lot size', lotSize.toLocaleString('en-IN'))}
      {calc.stoploss != null && pair('Stoploss', num(calc.stoploss), calc.stoplossPct, `₹${slAmount} ÷ lot size ${lotSize}; % of the stock price`)}
      {calc.target != null && pair('Target', num(calc.target), calc.targetPct, `₹${targetAmount} ÷ lot size ${lotSize}; % of the stock price`)}
      {price != null && pair('Stock price', `₹${num(price)}`, null, PRICE_SOURCE[source])}
    </div>
  )
}

// Daily change column: live value from Groww's quote API (day_change /
// day_change_perc); until it arrives (or if the quote fails) the value computed
// from the stored daily candles is shown, marked with a dotted underline.
function DayChange({ quote, group }) {
  const live = quote ?? null
  const change = live ? live.dayChange : group.dayChange
  const pct = live ? live.dayChangePct : group.dayChangePct
  if (change == null || pct == null) return <span className="text-[11px] font-mono text-on-surface-variant" title="Daily change unavailable">-</span>
  const up = change >= 0
  const sign = up ? '+' : ''
  const source = live ? 'Live from Groww quote' : 'Close vs previous day close (quote unavailable)'
  return (
    <span
      className={`text-[11px] font-mono ${up ? 'text-bullish' : 'text-bearish'} ${live ? '' : 'underline decoration-dotted'}`}
      title={`Daily change ${sign}${change.toFixed(2)} (${sign}${pct.toFixed(2)}%) · ${source}`}
    >
      {up ? '▲' : '▼'} {sign}{change.toFixed(2)} ({sign}{pct.toFixed(2)}%)
    </span>
  )
}

export default function CrossoverGroupCard({ group, isRead, onOpen, chartHover, optionChainHover, quote, slAmount = null, targetAmount = null }) {
  return (
    <div
      onClick={() => !isRead && onOpen(group)}
      className={`px-sm py-xs rounded-lg text-sm flex flex-col md:grid md:grid-cols-[minmax(0,1fr)_auto_auto_auto_auto_minmax(0,1fr)] gap-sm ${isRead ? 'text-on-surface-variant' : 'text-on-surface bg-surface-container-highest cursor-pointer'}`}
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
      {/* daily change and time stamp columns, before the chart */}
      <div className="text-xs text-on-surface-variant flex flex-col justify-center gap-[2px] md:border-l border-t md:border-t-0 border-outline-variant pt-xs md:pt-0 md:px-md">
        <div className="text-[11px] uppercase tracking-wide">Daily change</div>
        <DayChange quote={quote} group={group} />
      </div>
      <div className="text-xs text-on-surface-variant flex flex-col justify-center gap-[2px] md:border-l border-t md:border-t-0 border-outline-variant pt-xs md:pt-0 md:px-md">
        <div className="text-[11px] uppercase tracking-wide">Time</div>
        <div className="font-mono text-on-surface">{formatCrossoverTime(group)}</div>
      </div>
      {/* centre columns: chart, option chain */}
      <div className="flex items-center justify-center md:border-l border-t md:border-t-0 border-outline-variant pt-xs md:pt-0 md:px-md">{chartHover && <CardChartButton group={group} hover={chartHover} />}</div>
      {/* option-chain change column, right after the chart button */}
      <div className="flex items-center justify-center md:border-l border-t md:border-t-0 border-outline-variant pt-xs md:pt-0 md:px-md">{optionChainHover && <OptionChainButton group={group} hover={optionChainHover} />}</div>
      <div className="md:justify-self-end flex flex-col md:flex-row gap-sm md:gap-md">
        <MarginColumn margin={group.nrmlMargin} />
        <AdxColumn adx={group.adx} />
      </div>
      {(slAmount || targetAmount) && <StopTargetRow group={group} quote={quote} slAmount={slAmount} targetAmount={targetAmount} />}
    </div>
  )
}
