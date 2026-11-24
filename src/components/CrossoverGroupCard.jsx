/**
 * One merged crossover card on the Notifications page: every indicator that
 * crossed for one symbol on one bar of one timeframe (a `crossoverGroups` doc,
 * see functions/crossoverScanner.js buildCrossoverGroups). Stars = how many
 * distinct indicators crossed - the more, the more important. The card reads as a
 * table row: indicators | day change + time | chart + option chain | NRML margin + ADX
 * | (when Stoploss / Target amounts are entered on the tab) the suggested SL / Target
 * in one colour-coded column (from 1280 px; a full-width strip from 1024 px; wrapped below): Stoploss in
 * red, Target in green. Related values share a column to keep the columns narrow.
 */

import { DirectionBadge } from './NotificationContent'
import { CardChartButton } from './CardChartHover'
import { OptionChainButton } from './OptionChainHover'
import { formatCrossoverTime, formatLines, timeframeLabel } from './crossoverFormat'
import { describeStopTarget } from './stopTargetCalc'
import LotSizeEditor from './LotSizeEditor'

// Crossover indicators the scanner runs (CROSSOVER_SPECS) - the star scale.
export const MAX_STARS = 7

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

const ADX_STATUS = { increase: 'Increased', decrease: 'Decreased', flat: 'Flat' }
const PRICE_SOURCE = {
  live: { mark: '●', title: 'Live quote' },
  close: { mark: '○', title: 'Price of the crossover bar (no live quote yet)' },
  sheet: { mark: '◌', title: 'Price from the uploaded sheet (older; no live quote or bar close)' },
}

const label = 'text-[10px] uppercase tracking-wide text-on-surface-variant'
// Every column after the first: a divider between table columns from 1024 px; below that the columns wrap in one row under the indicators.
const columnClass = 'text-xs text-on-surface-variant lg:border-l border-outline-variant lg:px-sm flex flex-col justify-center gap-[2px]'

// Day change (live from Groww's quote, else computed from the stored candles - dotted underline) over the crossover time.
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

function ChangeTimeColumn({ quote, group }) {
  return (
    <div className={columnClass}>
      <div>
        <div className={label}>Day change</div>
        <DayChange quote={quote} group={group} />
      </div>
      <div className="pt-[2px]">
        <div className={label}>Time</div>
        <div className="font-mono text-on-surface">{formatCrossoverTime(group)}</div>
      </div>
    </div>
  )
}

// The two hover buttons, stacked, in one narrow column.
function ActionsColumn({ group, chartHover, optionChainHover }) {
  return (
    <div className={`${columnClass} lg:w-[84px] items-stretch`}>
      {chartHover && <CardChartButton group={group} hover={chartHover} compact />}
      {optionChainHover && <OptionChainButton group={group} hover={optionChainHover} compact text="Chain" />}
    </div>
  )
}

// NRML margin (edited on the Crossover Scanner page) and the ADX (trend strength) at that bar vs the bar before - plain text.
export function MarginAdxColumn({ margin, adx }) {
  const hasMargin = typeof margin === 'number' && Number.isFinite(margin)
  const row = (name, value, title) => (
    <div className="flex justify-between gap-sm whitespace-nowrap" title={title}>
      <span>{name}</span>
      <span className="font-mono text-on-surface">{value}</span>
    </div>
  )
  return (
    <div className={`${columnClass} lg:w-[150px]`}>
      {row('NRML', hasMargin ? `₹${margin.toLocaleString('en-IN')}` : '-', hasMargin ? `NRML margin ₹${margin}` : 'No NRML margin saved - add it on the Crossover Scanner page')}
      {row('ADX', adx ? `${adx.value.toFixed(2)} / ${adx.prev.toFixed(2)}` : '—', `ADX (${adx?.period || 14}) on this bar / on the bar before`)}
      {row('Trend', adx ? ADX_STATUS[adx.trend] : '—', 'ADX compared with the bar before')}
    </div>
  )
}

const money = (value) => value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

// Suggested Stoploss / Target (amounts entered on the Notifications tab; formulas in stopTargetCalc.js, the same as the
// Stp & Target sheet; lot size comes from the uploaded sheet). One tinted block: Stoploss in red, Target in green
// (risk / reward - not the card's bullish / bearish bias). Only the lines that can be computed are shown.
export function StopTargetColumn({ group, quote, slAmount, targetAmount, onLotSizeSaved }) {
  const info = describeStopTarget({ group, quote, slAmount, targetAmount })
  if (info.state === 'off') return null
  const box = `${columnClass} min-w-[150px] lg:col-span-full lg:flex-row lg:flex-wrap lg:items-baseline lg:gap-x-lg lg:border-l-0 lg:border-t lg:px-0 lg:pt-xs xl:col-auto xl:w-[176px] xl:flex-col xl:flex-nowrap xl:items-stretch xl:gap-x-0 xl:border-l xl:border-t-0 xl:px-sm xl:pt-0 xl:bg-white/[0.03] rounded-md bg-white/[0.03] px-sm py-xs`
  if (info.state === 'noLot') {
    return (
      <div className={box} aria-label="Suggested stoploss and target">
        <div className={label}>SL / Target</div>
        <div className="text-[11px] flex items-baseline gap-xs flex-wrap">
          <span title={info.reason === 'index' ? 'This index has no futures, so no lot size is known - type one if you want Stoploss / Target for it' : `${group.symbol} has no lot size yet - type it here`}>
            {info.reason === 'index' ? 'Index – no lot size' : 'No lot size'}
          </span>
          <LotSizeEditor group={group} lotSize={null} source={null} onSaved={onLotSizeSaved} />
        </div>
      </div>
    )
  }
  const line = (name, value, pct, tone, title) => (
    <div className={`flex items-baseline justify-between gap-sm lg:max-xl:gap-xs ${tone}`} title={title}>
      <span className="text-[10px] font-semibold tracking-wide">{name}</span>
      <span className="font-mono">
        <span className="font-semibold">{money(value)}</span>
        {pct != null && <span className="opacity-80"> · {money(pct)}%</span>}
      </span>
    </div>
  )
  const source = PRICE_SOURCE[info.priceSource]
  return (
    <div className={box} aria-label="Suggested stoploss and target">
      <div className={label}>SL / Target</div>
      <div className="flex justify-between gap-sm lg:max-xl:gap-xs">
        <span>Lot</span>
        <LotSizeEditor group={group} lotSize={info.lotSize} source={group.lotSizeSource} onSaved={onLotSizeSaved} />
      </div>
      {info.stoploss != null && line('SL', info.stoploss, info.stoplossPct, 'text-bearish', `Stoploss: ₹${slAmount} ÷ lot size ${info.lotSize}; % of the stock price`)}
      {info.target != null && line('TGT', info.target, info.targetPct, 'text-bullish', `Target: ₹${targetAmount} ÷ lot size ${info.lotSize}; % of the stock price`)}
      {info.price != null && (
        <div className="flex justify-between gap-sm lg:max-xl:gap-xs" title={source?.title}>
          <span>Price</span>
          <span className="font-mono text-on-surface">₹{money(info.price)} <span className="text-[10px] text-on-surface-variant" aria-label={source?.title}>{source?.mark}</span></span>
        </div>
      )}
    </div>
  )
}

export default function CrossoverGroupCard({ group, isRead, onOpen, chartHover, optionChainHover, quote, slAmount = null, targetAmount = null, lotSizeEdit = null, onLotSizeSaved }) {
  const showStopTarget = Boolean(slAmount || targetAmount)
  // A lot size just typed on any card of this symbol wins over what this card was loaded with.
  const stopTargetGroup = lotSizeEdit ? { ...group, lotSize: lotSizeEdit.lotSize, lotSizeSource: lotSizeEdit.lotSizeSource } : group
  return (
    <div
      onClick={() => !isRead && onOpen(group)}
      className={`px-sm py-xs rounded-lg text-sm flex flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_auto_auto_auto] ${showStopTarget ? 'xl:grid-cols-[minmax(0,1fr)_auto_auto_auto_auto]' : ''} gap-sm ${isRead ? 'text-on-surface-variant' : 'text-on-surface bg-surface-container-highest cursor-pointer'}`}
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
      {/* below 1024 px these columns wrap in one row under the indicators; from 1024 px (display: contents) they are the table's columns */}
      <div className="flex flex-wrap items-stretch gap-x-md gap-y-sm border-t border-outline-variant pt-xs lg:contents">
        <ChangeTimeColumn quote={quote} group={group} />
        <ActionsColumn group={group} chartHover={chartHover} optionChainHover={optionChainHover} />
        <MarginAdxColumn margin={group.nrmlMargin} adx={group.adx} />
        {showStopTarget && <StopTargetColumn group={stopTargetGroup} quote={quote} slAmount={slAmount} targetAmount={targetAmount} onLotSizeSaved={onLotSizeSaved} />}
      </div>
    </div>
  )
}
