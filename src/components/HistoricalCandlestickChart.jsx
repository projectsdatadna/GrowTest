/**
 * OHLC price chart (Plotly's `ohlc` trace type, per
 * plotly.com/javascript/ohlc-charts/). SMA/EMA/Bollinger Bands,
 * Support/Resistance levels, and RSI Divergence lines overlay directly on
 * the price panel (same price units); RSI, MACD, TSI, Stoch RSI, and ADX
 * each get their own stacked row below (oscillators, not price-unit values,
 * so they can't overlay). All rows share Plotly's single default x-axis, so
 * drag-to-zoom/pan stays in sync across every visible row for free (no
 * manual chart-sync code needed, unlike a multi-instance charting library).
 */
import { useMemo } from 'react'
import createPlotlyComponent from 'react-plotly.js/factory'
import Plotly from 'plotly.js-finance-dist-min'

const Plot = createPlotlyComponent(Plotly)

const COLOR_UP = '#27D67B'
const COLOR_DOWN = '#ffb4ab'
const COLOR_PRIMARY = '#c1c1ff'
const COLOR_SECONDARY = '#42e78a'
const COLOR_GRID = '#243248'
const COLOR_TEXT = '#c7c4d6'

// Moving averages + Bollinger Bands now overlay directly on the price panel
// (see the price trace block below) rather than getting their own row, so
// their colors have to stay distinguishable from the up/down candles AND
// from each other on the same panel - COLOR_SECONDARY (mint green) is too
// close to COLOR_UP for that, so EMA/Bollinger get their own hues here
// instead of reusing it (COLOR_SECONDARY itself is still used by MACD's
// Signal line, which lives in its own separate row and has no such clash).
const COLOR_EMA = '#ffb454'
const COLOR_BB_BAND = '#8f6fff'
const COLOR_BB_MIDDLE = '#8fa3c8'
// Same bullish/bearish hexes as the app's Tailwind theme (index.html) and
// ProbabilityGauge's text-bullish/text-bearish, so support/resistance reads
// consistently with the rest of the app rather than introducing new hues.
const COLOR_SUPPORT = '#27D67B'
const COLOR_RESISTANCE = '#FF5B6E'

// Each panel gets a fixed pixel height regardless of how many are active -
// domain fractions are computed against a total that GROWS with panel
// count, rather than splitting one fixed total evenly (which was shrinking
// every panel as more indicators got enabled - the more panels, the less
// readable each one). The chart component itself grows taller as a result;
// the page (no overflow:hidden anywhere up the tree - see AppShell.jsx)
// just scrolls to show it, rather than everything fighting for one static
// box.
const PRICE_HEIGHT_PX = 380
const INDICATOR_HEIGHT_PX = 170
const GAP_PX = 24
const CHROME_PX = 140 // margins + legend + the range slider's own reserved strip

// IST has a fixed +05:30 offset with no DST, so a flat offset add is exact -
// no need for Intl/timezone-database lookups.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000

function istDateParts(timestampSeconds) {
  return new Date(timestampSeconds * 1000 + IST_OFFSET_MS)
}

// Formats as an IST wall-clock string ("YYYY-MM-DD HH:MM:SS") rather than
// returning a native JS Date - Plotly's date axis parses string values
// literally with no further timezone conversion, whereas a Date has its
// hour/day-of-week read back out in the *viewer's own browser timezone* when
// Plotly builds tick labels and matches xaxis.rangebreaks bounds below.
// Every trace in this file funnels through this one function, so this single
// change keeps everything - including the IST-anchored rangebreaks below -
// correct regardless of which timezone the browser is in.
function toPlotlyDate(timestampSeconds) {
  const d = istDateParts(timestampSeconds)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

// Plotly renders OHLC data on a continuous real-time x-axis by default, so
// any stretch with no candles - weekends, exchange holidays, the overnight
// non-market span, or (for an interval like 4 Hour whose candle buckets are
// anchored to a fixed clock grid rather than the real 9:15 session open) any
// other gap between an interval's own candle boundaries - still gets its
// proportional width reserved with nothing drawn in it, which reads as a
// blank gap. xaxis.rangebreaks tells Plotly to collapse specific spans
// instead.
//
// Every such gap is detected directly from the loaded candles themselves,
// rather than assuming a fixed market-hours window (e.g. 9:15-15:30): the
// smallest gap between any two consecutive candles is taken as the real
// interval width (however the data provider aligns its buckets - 4h for 4
// Hour, 900s for 15 Minute, 86400s for 1 Day, etc.), and any gap notably
// larger than that gets its own explicit collapsed span between the two real
// timestamps on either side of it. This works uniformly for every interval,
// with no per-interval special-casing and no hardcoded exchange calendar -
// confirmed necessary after a fixed [15:30, 9:15] hour-of-day rule (this
// function's previous approach) corrupted Plotly's rangebreak pixel mapping
// for the 4 Hour interval specifically: Groww's 4-hour bars are timestamped
// on a fixed 08:00/12:00 clock grid, not 9:15/13:15, so that assumption put
// a real candle's own timestamp inside the span being hidden.
function computeRangebreaks(candles) {
  const rangebreaks = [{ bounds: ['sat', 'mon'] }]
  if (candles.length < 2) return rangebreaks

  const gapsSeconds = []
  for (let i = 1; i < candles.length; i++) gapsSeconds.push(candles[i].timestamp - candles[i - 1].timestamp)
  const baseIntervalSeconds = Math.min(...gapsSeconds)

  for (let i = 1; i < candles.length; i++) {
    const prevTs = candles[i - 1].timestamp
    const currTs = candles[i].timestamp
    const gapSeconds = currTs - prevTs
    if (gapSeconds <= baseIntervalSeconds * 1.5) continue // normal spacing, nothing to collapse

    // Leave a small pad on each side so the two real candles bounding this
    // break keep their own normal-looking width instead of sitting flush
    // against the break edge (Plotly's bounds are ambiguous about whether
    // the edge itself is included, and a candle sitting exactly on it is
    // what corrupted the pixel mapping before).
    const pad = Math.min(baseIntervalSeconds * 0.4, gapSeconds / 4)
    rangebreaks.push({ bounds: [toPlotlyDate(prevTs + pad), toPlotlyDate(currTs - pad)] })
  }

  return rangebreaks
}

// Splits [0,1] vertically: price gets the top slice, indicator rows below it
// each get a slice sized so that, once multiplied back out by plotHeightPx,
// every panel is the same fixed pixel height (see comment above).
function computeDomains(indicatorRowCount) {
  const plotHeightPx = PRICE_HEIGHT_PX + indicatorRowCount * (INDICATOR_HEIGHT_PX + GAP_PX)
  if (indicatorRowCount === 0) {
    return { price: [0, 1], rows: [], plotHeightPx }
  }
  const priceDomain = [1 - PRICE_HEIGHT_PX / plotHeightPx, 1]

  const rows = []
  let top = priceDomain[0]
  for (let i = 0; i < indicatorRowCount; i++) {
    top -= GAP_PX / plotHeightPx
    const bottom = top - INDICATOR_HEIGHT_PX / plotHeightPx
    rows.push([bottom, top])
    top = bottom
  }
  return { price: priceDomain, rows, plotHeightPx }
}

function seriesToXY(points) {
  return { x: points.map((p) => toPlotlyDate(p.timestamp)), y: points.map((p) => p.value) }
}

// A small corner label instead of Plotly's rotated y-axis title - with 4
// short stacked panels, adjacent axis titles are tall enough (vertically
// centered on their own domain) to visually collide with each other. A
// paper-coordinate annotation pinned to each panel's own top-left corner
// has no such collision, the standard fix for this in multi-panel charts.
function panelLabel(text, domainTop) {
  return {
    text,
    xref: 'paper',
    yref: 'paper',
    x: 0.005,
    y: domainTop - 0.005,
    xanchor: 'left',
    yanchor: 'top',
    showarrow: false,
    font: { color: COLOR_TEXT, size: 11 },
  }
}

// Mode bar tools that don't apply to OHLC/indicator data - trimmed out so
// zoom/pan/autoscale/download-as-PNG (the ones that do apply) aren't buried
// among irrelevant selection tools.
const MODE_BAR_BUTTONS_TO_REMOVE = ['lasso2d', 'select2d']

// Shared by every crossover indicator (MACD/TSI/Stoch RSI/ADX/SMA/EMA) -
// each computes 'bullish'/'bearish' single-point events the same way (see
// e.g. macdCrossoverIndicator.js), so the marker rendering (with legend
// dedup) is identical too; only which field of event.value holds the
// oscillator-panel y-value differs, whether there's an oscillator panel at
// all, and whether this crossover's "home" is the price panel or an
// oscillator panel of its own (showOnPricePanel) - a crossover only ever
// draws on its own respective panel(s), never as a fallback on the other.
// SMA/EMA crossovers pass oscillatorYAxis: null since both their lines
// already overlay the price panel, same as the plain SMA/EMA lines do, so
// the price panel *is* their one respective panel. MACD/TSI/Stoch
// RSI/ADX crossovers pass showOnPricePanel: false since each has its own
// respective oscillator panel instead - drawing on price too would be a
// crossover appearing somewhere it doesn't belong.
function pushCrossoverTraces(traces, events, { oscillatorYAxis, oscillatorField, legendPrefix, showOnPricePanel = true }) {
  let shownBullishLegend = false
  let shownBearishLegend = false

  for (const event of events) {
    const { type, price } = event.value
    const isBullish = type === 'bullish'
    const color = isBullish ? COLOR_SUPPORT : COLOR_RESISTANCE
    const showLegend = isBullish ? !shownBullishLegend : !shownBearishLegend
    if (isBullish) shownBullishLegend = true
    else shownBearishLegend = true

    // A circle-around-the-point marker (not a 2-point line) - a crossover
    // is one instant in time (unlike divergence's two-swing-point line), so
    // a hollow ring reads clearly as its own signal type against
    // divergence's line+filled-circle markers.
    const marker = { color, size: 10, symbol: 'circle-open-dot', line: { width: 2 } }

    if (showOnPricePanel) {
      traces.push({
        type: 'scatter',
        mode: 'markers',
        name: isBullish ? 'Bullish Crossover' : 'Bearish Crossover',
        x: [toPlotlyDate(event.timestamp)],
        y: [price],
        marker,
        showlegend: showLegend,
        legendgroup: `${legendPrefix}-${type}`,
        xaxis: 'x',
        yaxis: 'y',
      })
    }

    if (oscillatorYAxis) {
      // The legend entry attaches to whichever copy actually gets drawn -
      // the price-panel one above when this crossover lives there (SMA/EMA),
      // otherwise this oscillator-panel copy, so "Bullish/Bearish Crossover"
      // stays toggleable with exactly one legend entry either way, and
      // simply doesn't appear when neither copy is drawn (oscillator panel
      // hidden and this crossover doesn't belong on the price panel).
      traces.push({
        type: 'scatter',
        mode: 'markers',
        name: isBullish ? 'Bullish Crossover' : 'Bearish Crossover',
        x: [toPlotlyDate(event.timestamp)],
        y: [event.value[oscillatorField]],
        marker,
        showlegend: showOnPricePanel ? false : showLegend,
        legendgroup: `${legendPrefix}-${type}`,
        xaxis: 'x',
        yaxis: oscillatorYAxis,
      })
    }
  }
}

function HistoricalCandlestickChart({ candles, indicatorSeries, indicatorConfig, isFullscreen = false }) {
  const { data, layout } = useMemo(() => {
    const showRsi = indicatorConfig.rsi.enabled
    const showMacd = indicatorConfig.macd.enabled
    const showTsi = indicatorConfig.tsi.enabled
    const showStochRsi = indicatorConfig.stochRsi.enabled
    const showAdx = indicatorConfig.adx.enabled

    // SMA/EMA/Bollinger Bands overlay directly on the price panel below (same
    // price units as the candles) rather than getting their own row - only
    // RSI/MACD/TSI/Stoch RSI/ADX are oscillators that need their own
    // y-scale, so only they appear here. Order matters: this list's order is
    // the stacking order top-to-bottom below the price row, and its length
    // determines the y-axis each row gets (rows[0] -> 'y2', rows[1] -> 'y3', ...).
    const indicatorRows = [showRsi && 'rsi', showMacd && 'macd', showTsi && 'tsi', showStochRsi && 'stochRsi', showAdx && 'adx'].filter(Boolean)

    const { price: priceDomain, rows: rowDomains, plotHeightPx } = computeDomains(indicatorRows.length)
    const yAxisKeyFor = (rowName) => {
      const index = indicatorRows.indexOf(rowName)
      return index === -1 ? null : `y${index + 2}` // y2, y3, y4, y5
    }

    const traces = [
      {
        type: 'ohlc',
        name: 'Price',
        x: candles.map((c) => toPlotlyDate(c.timestamp)),
        open: candles.map((c) => c.open),
        high: candles.map((c) => c.high),
        low: candles.map((c) => c.low),
        close: candles.map((c) => c.close),
        increasing: { line: { color: COLOR_UP } },
        decreasing: { line: { color: COLOR_DOWN } },
        xaxis: 'x',
        yaxis: 'y',
      },
    ]

    if (indicatorConfig.sma.enabled) {
      const points = indicatorSeries[`SMA:${indicatorConfig.sma.period}`] || []
      traces.push({ type: 'scatter', mode: 'lines', name: `SMA ${indicatorConfig.sma.period}`, ...seriesToXY(points), line: { color: COLOR_PRIMARY, width: 1.5 }, xaxis: 'x', yaxis: 'y' })
    }
    if (indicatorConfig.ema.enabled) {
      const points = indicatorSeries[`EMA:${indicatorConfig.ema.period}`] || []
      traces.push({ type: 'scatter', mode: 'lines', name: `EMA ${indicatorConfig.ema.period}`, ...seriesToXY(points), line: { color: COLOR_EMA, width: 1.5 }, xaxis: 'x', yaxis: 'y' })
    }
    if (indicatorConfig.bollingerBands.enabled) {
      const { period, stdDev } = indicatorConfig.bollingerBands
      const points = indicatorSeries[`BB:${period}:${stdDev}`] || []
      const x = points.map((p) => toPlotlyDate(p.timestamp))
      // Upper then Lower (adjacent, nothing pushed between them) so Lower's
      // fill:'tonexty' shades the channel back to Upper - Plotly fills
      // against whichever trace immediately precedes it in `data`. Middle is
      // pushed after so it doesn't break that adjacency.
      traces.push({ type: 'scatter', mode: 'lines', name: 'BB Upper', x, y: points.map((p) => p.value?.upper), line: { color: COLOR_BB_BAND, width: 1 }, xaxis: 'x', yaxis: 'y' })
      traces.push({ type: 'scatter', mode: 'lines', name: 'BB Lower', x, y: points.map((p) => p.value?.lower), line: { color: COLOR_BB_BAND, width: 1 }, fill: 'tonexty', fillcolor: 'rgba(143,111,255,0.12)', xaxis: 'x', yaxis: 'y' })
      traces.push({ type: 'scatter', mode: 'lines', name: 'BB Middle', x, y: points.map((p) => p.value?.middle), line: { color: COLOR_BB_MIDDLE, width: 1, dash: 'dash' }, xaxis: 'x', yaxis: 'y' })
    }

    if (indicatorConfig.rsiDivergence.enabled) {
      const { rsiPeriod, lookback } = indicatorConfig.rsiDivergence
      const events = indicatorSeries[`RSIDIV:${rsiPeriod}:${lookback}`] || []
      // Only draws the matching line on the RSI oscillator panel when that
      // row is ALSO currently active - divergence computes its own RSI
      // internally (functions/technicalIndicators.js) so it doesn't need
      // the RSI row to be enabled, but the second line is only meaningful
      // (and only has a panel to draw on) when RSI is visible too.
      const rsiYAxis = showRsi ? yAxisKeyFor('rsi') : null
      let shownBullishLegend = false
      let shownBearishLegend = false

      for (const event of events) {
        const { type, startTimestamp, startPrice, endTimestamp, endPrice, startRsi, endRsi } = event.value
        const isBullish = type === 'bullish'
        const color = isBullish ? COLOR_SUPPORT : COLOR_RESISTANCE
        const showLegend = isBullish ? !shownBullishLegend : !shownBearishLegend
        if (isBullish) shownBullishLegend = true
        else shownBearishLegend = true

        // A plain 2-point line+marker trace (not a paper-referenced shape
        // like Support/Resistance uses) - this needs real data-coordinate
        // endpoints with visible markers, which a trace gives for free.
        // legendgroup ties the price-panel and RSI-panel copies of the same
        // event together so toggling the one visible legend entry hides
        // both at once.
        traces.push({
          type: 'scatter',
          mode: 'lines+markers',
          name: isBullish ? 'Bullish Divergence' : 'Bearish Divergence',
          x: [toPlotlyDate(startTimestamp), toPlotlyDate(endTimestamp)],
          y: [startPrice, endPrice],
          line: { color, width: 2 },
          marker: { color, size: 6 },
          showlegend: showLegend,
          legendgroup: type,
          xaxis: 'x',
          yaxis: 'y',
        })

        if (rsiYAxis) {
          traces.push({
            type: 'scatter',
            mode: 'lines+markers',
            name: isBullish ? 'Bullish Divergence' : 'Bearish Divergence',
            x: [toPlotlyDate(startTimestamp), toPlotlyDate(endTimestamp)],
            y: [startRsi, endRsi],
            line: { color, width: 2 },
            marker: { color, size: 6 },
            showlegend: false,
            legendgroup: type,
            xaxis: 'x',
            yaxis: rsiYAxis,
          })
        }
      }
    }

    // Each crossover indicator computes its own underlying series
    // internally, so none of these need their plain-indicator counterpart
    // enabled - the second (oscillator-panel) marker is only meaningful
    // (and only has a panel to draw on) when that counterpart is visible
    // too, same conditional-mirror pattern RSI Divergence's rsiYAxis uses
    // above.
    if (indicatorConfig.macdCrossover.enabled) {
      const { fastPeriod, slowPeriod, signalPeriod } = indicatorConfig.macdCrossover
      const events = indicatorSeries[`MACDCROSS:${fastPeriod}:${slowPeriod}:${signalPeriod}`] || []
      pushCrossoverTraces(traces, events, { oscillatorYAxis: showMacd ? yAxisKeyFor('macd') : null, oscillatorField: 'macd', legendPrefix: 'macdcross', showOnPricePanel: false })
    }

    if (indicatorConfig.tsiCrossover.enabled) {
      const { longPeriod, shortPeriod, signalPeriod } = indicatorConfig.tsiCrossover
      const events = indicatorSeries[`TSICROSS:${longPeriod}:${shortPeriod}:${signalPeriod}`] || []
      pushCrossoverTraces(traces, events, { oscillatorYAxis: showTsi ? yAxisKeyFor('tsi') : null, oscillatorField: 'tsi', legendPrefix: 'tsicross', showOnPricePanel: false })
    }

    if (indicatorConfig.stochRsiCrossover.enabled) {
      const { rsiPeriod, stochasticPeriod, kPeriod, dPeriod } = indicatorConfig.stochRsiCrossover
      const events = indicatorSeries[`STOCHRSICROSS:${rsiPeriod}:${stochasticPeriod}:${kPeriod}:${dPeriod}`] || []
      pushCrossoverTraces(traces, events, { oscillatorYAxis: showStochRsi ? yAxisKeyFor('stochRsi') : null, oscillatorField: 'k', legendPrefix: 'stochrsicross', showOnPricePanel: false })
    }

    if (indicatorConfig.adxCrossover.enabled) {
      const events = indicatorSeries[`ADXCROSS:${indicatorConfig.adxCrossover.period}`] || []
      pushCrossoverTraces(traces, events, { oscillatorYAxis: showAdx ? yAxisKeyFor('adx') : null, oscillatorField: 'pdi', legendPrefix: 'adxcross', showOnPricePanel: false })
    }

    // SMA/EMA crossovers overlay the price panel only (both lines are
    // already price-scale, same as the plain SMA/EMA lines) - no oscillator
    // panel to mirror onto, so oscillatorYAxis is always null and
    // showOnPricePanel stays at its default true (the price panel is their
    // one respective panel, unlike the 4 oscillator crossovers above).
    if (indicatorConfig.smaCrossover.enabled) {
      const { fastPeriod, slowPeriod } = indicatorConfig.smaCrossover
      const events = indicatorSeries[`SMACROSS:${fastPeriod}:${slowPeriod}`] || []
      pushCrossoverTraces(traces, events, { oscillatorYAxis: null, oscillatorField: null, legendPrefix: 'smacross' })
    }

    if (indicatorConfig.emaCrossover.enabled) {
      const { fastPeriod, slowPeriod } = indicatorConfig.emaCrossover
      const events = indicatorSeries[`EMACROSS:${fastPeriod}:${slowPeriod}`] || []
      pushCrossoverTraces(traces, events, { oscillatorYAxis: null, oscillatorField: null, legendPrefix: 'emacross' })
    }

    const layoutAxes = {
      // Plotly's built-in range slider - the standard mini-navigator strip
      // under the price panel (shown by default on plotly.com's own OHLC
      // chart examples) for dragging to pan/zoom through time without
      // losing the full-range overview. Previously disabled here reasoning
      // it was redundant with the stacked indicator panels below - it isn't.
      xaxis: {
        rangeslider: { visible: true, bgcolor: COLOR_GRID, bordercolor: COLOR_GRID, thickness: 0.08 },
        rangebreaks: computeRangebreaks(candles),
        gridcolor: COLOR_GRID,
        color: COLOR_TEXT,
      },
      yaxis: { domain: priceDomain, gridcolor: COLOR_GRID, color: COLOR_TEXT },
    }
    const annotations = [panelLabel('Price', priceDomain[1])]

    if (indicatorConfig.supportResistance.enabled) {
      const points = indicatorSeries[`SR:${indicatorConfig.supportResistance.lookback}`] || []
      layoutAxes.shapes = [...(layoutAxes.shapes || []), ...supportResistanceLines(points)]
      annotations.push(...supportResistanceLabels(points))
    }

    if (showRsi) {
      const yaxis = yAxisKeyFor('rsi')
      const axisKey = `yaxis${yaxis.slice(1)}`
      const domain = rowDomains[indicatorRows.indexOf('rsi')]
      layoutAxes[axisKey] = { domain, range: [0, 100], gridcolor: COLOR_GRID, color: COLOR_TEXT }
      annotations.push(panelLabel('RSI', domain[1]))

      const points = indicatorSeries[`RSI:${indicatorConfig.rsi.period}`] || []
      traces.push({ type: 'scatter', mode: 'lines', name: `RSI ${indicatorConfig.rsi.period}`, ...seriesToXY(points), line: { color: COLOR_PRIMARY, width: 1.5 }, xaxis: 'x', yaxis })

      layoutAxes.shapes = [...(layoutAxes.shapes || []), ...referenceLines(yaxis, [30, 70])]
    }

    if (showMacd) {
      const yaxis = yAxisKeyFor('macd')
      const axisKey = `yaxis${yaxis.slice(1)}`
      const domain = rowDomains[indicatorRows.indexOf('macd')]
      layoutAxes[axisKey] = { domain, gridcolor: COLOR_GRID, color: COLOR_TEXT }
      annotations.push(panelLabel('MACD', domain[1]))

      const { fastPeriod, slowPeriod, signalPeriod } = indicatorConfig.macd
      const points = indicatorSeries[`MACD:${fastPeriod}:${slowPeriod}:${signalPeriod}`] || []
      const x = points.map((p) => toPlotlyDate(p.timestamp))
      traces.push({
        type: 'bar',
        name: 'Histogram',
        x,
        y: points.map((p) => p.value?.histogram),
        marker: { color: points.map((p) => ((p.value?.histogram ?? 0) >= 0 ? COLOR_UP : COLOR_DOWN)) },
        xaxis: 'x',
        yaxis,
      })
      traces.push({ type: 'scatter', mode: 'lines', name: 'MACD', x, y: points.map((p) => p.value?.macd), line: { color: COLOR_PRIMARY, width: 1.5 }, xaxis: 'x', yaxis })
      traces.push({ type: 'scatter', mode: 'lines', name: 'Signal', x, y: points.map((p) => p.value?.signal), line: { color: COLOR_SECONDARY, width: 1.5 }, xaxis: 'x', yaxis })
    }

    if (showTsi) {
      const yaxis = yAxisKeyFor('tsi')
      const axisKey = `yaxis${yaxis.slice(1)}`
      const domain = rowDomains[indicatorRows.indexOf('tsi')]
      layoutAxes[axisKey] = { domain, gridcolor: COLOR_GRID, color: COLOR_TEXT }
      annotations.push(panelLabel('TSI', domain[1]))

      const { longPeriod, shortPeriod, signalPeriod } = indicatorConfig.tsi
      const points = indicatorSeries[`TSI:${longPeriod}:${shortPeriod}:${signalPeriod}`] || []
      const x = points.map((p) => toPlotlyDate(p.timestamp))
      traces.push({ type: 'scatter', mode: 'lines', name: 'TSI', x, y: points.map((p) => p.value?.tsi), line: { color: COLOR_PRIMARY, width: 1.5 }, xaxis: 'x', yaxis })
      traces.push({ type: 'scatter', mode: 'lines', name: 'TSI Signal', x, y: points.map((p) => p.value?.signal), line: { color: COLOR_SECONDARY, width: 1.5 }, xaxis: 'x', yaxis })

      layoutAxes.shapes = [...(layoutAxes.shapes || []), ...referenceLines(yaxis, [0])]
    }

    if (showStochRsi) {
      const yaxis = yAxisKeyFor('stochRsi')
      const axisKey = `yaxis${yaxis.slice(1)}`
      const domain = rowDomains[indicatorRows.indexOf('stochRsi')]
      layoutAxes[axisKey] = { domain, range: [0, 100], gridcolor: COLOR_GRID, color: COLOR_TEXT }
      annotations.push(panelLabel('Stoch RSI', domain[1]))

      const { rsiPeriod, stochasticPeriod, kPeriod, dPeriod } = indicatorConfig.stochRsi
      const points = indicatorSeries[`STOCHRSI:${rsiPeriod}:${stochasticPeriod}:${kPeriod}:${dPeriod}`] || []
      const x = points.map((p) => toPlotlyDate(p.timestamp))
      // Stoch RSI's own %K/%D pair - k is the faster line, d is its
      // smoothed signal, same role as MACD's line+signal pairing.
      traces.push({ type: 'scatter', mode: 'lines', name: 'Stoch RSI %K', x, y: points.map((p) => p.value?.k), line: { color: COLOR_PRIMARY, width: 1.5 }, xaxis: 'x', yaxis })
      traces.push({ type: 'scatter', mode: 'lines', name: 'Stoch RSI %D', x, y: points.map((p) => p.value?.d), line: { color: COLOR_SECONDARY, width: 1.5 }, xaxis: 'x', yaxis })

      layoutAxes.shapes = [...(layoutAxes.shapes || []), ...referenceLines(yaxis, [20, 80])]
    }

    if (showAdx) {
      const yaxis = yAxisKeyFor('adx')
      const axisKey = `yaxis${yaxis.slice(1)}`
      const domain = rowDomains[indicatorRows.indexOf('adx')]
      layoutAxes[axisKey] = { domain, range: [0, 100], gridcolor: COLOR_GRID, color: COLOR_TEXT }
      annotations.push(panelLabel('ADX', domain[1]))

      const points = indicatorSeries[`ADX:${indicatorConfig.adx.period}`] || []
      const x = points.map((p) => toPlotlyDate(p.timestamp))
      traces.push({ type: 'scatter', mode: 'lines', name: 'ADX', x, y: points.map((p) => p.value?.adx), line: { color: COLOR_PRIMARY, width: 1.5 }, xaxis: 'x', yaxis })
      // +DI/-DI reuse the app's bullish/bearish palette (same as
      // Support/Resistance) - +DI is upward directional strength, -DI is
      // downward, the same semantic pairing.
      traces.push({ type: 'scatter', mode: 'lines', name: '+DI', x, y: points.map((p) => p.value?.pdi), line: { color: COLOR_SUPPORT, width: 1 }, xaxis: 'x', yaxis })
      traces.push({ type: 'scatter', mode: 'lines', name: '-DI', x, y: points.map((p) => p.value?.mdi), line: { color: COLOR_RESISTANCE, width: 1 }, xaxis: 'x', yaxis })

      layoutAxes.shapes = [...(layoutAxes.shapes || []), ...referenceLines(yaxis, [25])]
    }

    // Fullscreen wraps the plot in its own scrollable container (see
    // HistoricalChartTab.jsx), so growing taller than one screen is fine -
    // this just makes sure a short chart (few/no indicator panels) still
    // fills the available viewport instead of leaving a band of empty
    // background below it. FULLSCREEN_CHROME_PX approximates the fullscreen
    // toolbar row + surrounding padding that sits above the plot.
    const FULLSCREEN_CHROME_PX = 100
    const plotHeight = isFullscreen ? Math.max(plotHeightPx + CHROME_PX, window.innerHeight - FULLSCREEN_CHROME_PX) : plotHeightPx + CHROME_PX

    return {
      data: traces,
      layout: {
        ...layoutAxes,
        annotations,
        height: plotHeight,
        autosize: true,
        margin: { l: 45, r: 20, t: 10, b: 30 },
        showlegend: true,
        legend: { orientation: 'h', font: { color: COLOR_TEXT, size: 10 } },
        paper_bgcolor: 'transparent',
        plot_bgcolor: 'transparent',
        font: { color: COLOR_TEXT },
      },
    }
  }, [candles, indicatorSeries, indicatorConfig, isFullscreen])

  // No inline height here - layout.height above drives the actual size (it
  // grows as more indicator panels are enabled), autosize + useResizeHandler
  // still keep the width responsive.
  return (
    <Plot
      data={data}
      layout={layout}
      style={{ width: '100%' }}
      useResizeHandler
      config={{ displaylogo: false, displayModeBar: true, modeBarButtonsToRemove: MODE_BAR_BUTTONS_TO_REMOVE }}
    />
  )
}

// Dotted threshold reference lines (RSI's 30/70, Stoch RSI's 20/80, ADX's
// 25, TSI's 0) for an oscillator panel, anchored to that panel's own y-axis
// but spanning the full plot width (xref: 'paper').
function referenceLines(yaxis, levels) {
  const yref = yaxis
  return levels.map((level) => ({
    type: 'line',
    xref: 'paper',
    x0: 0,
    x1: 1,
    yref,
    y0: level,
    y1: level,
    line: { color: COLOR_TEXT, width: 1, dash: 'dot' },
  }))
}

// Horizontal dashed lines for scripted Support/Resistance levels - on the
// price panel's own y-axis ('y', data-referenced) but spanning the full
// plot width (xref: 'paper'), same technique as the RSI reference lines.
function supportResistanceLines(points) {
  return points.map((p) => ({
    type: 'line',
    xref: 'paper',
    x0: 0,
    x1: 1,
    yref: 'y',
    y0: p.value.price,
    y1: p.value.price,
    line: { color: p.value.type === 'support' ? COLOR_SUPPORT : COLOR_RESISTANCE, width: 1, dash: 'dash' },
  }))
}

// Small price-level label pinned to the right edge of each S/R line (mixed
// paper x / data y reference - Plotly annotations support this directly).
function supportResistanceLabels(points) {
  return points.map((p) => ({
    text: `${p.value.type === 'support' ? 'S' : 'R'} ${p.value.price.toFixed(2)}`,
    xref: 'paper',
    yref: 'y',
    x: 0.995,
    y: p.value.price,
    xanchor: 'right',
    yanchor: 'bottom',
    showarrow: false,
    font: { color: p.value.type === 'support' ? COLOR_SUPPORT : COLOR_RESISTANCE, size: 10 },
  }))
}

export default HistoricalCandlestickChart
