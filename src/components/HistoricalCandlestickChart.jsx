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

function istDateString(timestampSeconds) {
  const d = istDateParts(timestampSeconds)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

// Plotly renders OHLC data on a continuous real-time x-axis by default, so
// any stretch with no candles - weekends, exchange holidays, and (for
// intraday intervals) the overnight non-market span - still gets its
// proportional width reserved with nothing drawn in it, which reads as a
// blank gap. xaxis.rangebreaks tells Plotly to collapse specific spans
// instead. Weekends are a fixed rule; whether the data is intraday (and so
// has an overnight span to collapse) is inferred from the candles' own
// median spacing rather than threaded down as a prop, since nothing else
// here needs to know the interval. Real holidays aren't a fixed weekly rule
// and this app has no hardcoded exchange calendar to maintain - instead, any
// weekday with zero candles between two directly-adjacent candles is, by
// definition, a day the market didn't trade, so it's detected straight from
// the loaded data and added as an explicit single-day rangebreak.
function computeRangebreaks(candles) {
  const rangebreaks = [{ bounds: ['sat', 'mon'] }]
  if (candles.length < 2) return rangebreaks

  const gapsSeconds = []
  for (let i = 1; i < candles.length; i++) gapsSeconds.push(candles[i].timestamp - candles[i - 1].timestamp)
  const sortedGaps = [...gapsSeconds].sort((a, b) => a - b)
  const medianGapSeconds = sortedGaps[Math.floor(sortedGaps.length / 2)]
  const isIntraday = medianGapSeconds < 20 * 60 * 60
  if (isIntraday) {
    rangebreaks.push({ bounds: [15.5, 9.25], pattern: 'hour' })
  }

  const holidayDates = new Set()
  for (let i = 1; i < candles.length; i++) {
    const prevTs = candles[i - 1].timestamp
    const prevDateStr = istDateString(prevTs)
    const currDateStr = istDateString(candles[i].timestamp)
    if (prevDateStr === currDateStr) continue // same trading day, nothing to check

    // Crossed at least one calendar-day boundary - walk each IST calendar
    // date strictly between prev's day and curr's day and flag any weekday
    // among them as a holiday (zero candles exist for it, by definition,
    // since these are two directly adjacent candles).
    let cursor = prevTs + 24 * 60 * 60
    let guard = 0
    while (istDateString(cursor) !== currDateStr && guard < 10) {
      const dayOfWeek = istDateParts(cursor).getUTCDay()
      if (dayOfWeek !== 0 && dayOfWeek !== 6) holidayDates.add(istDateString(cursor))
      cursor += 24 * 60 * 60
      guard++
    }
  }
  if (holidayDates.size > 0) {
    rangebreaks.push({ values: [...holidayDates] })
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
// e.g. macdCrossoverIndicator.js), so the price-panel + oscillator-panel
// marker rendering (with legend dedup) is identical too; only which field
// of event.value holds the oscillator-panel y-value differs, and whether
// there's an oscillator panel at all - SMA/EMA crossovers pass
// oscillatorYAxis: null since both their lines already overlay the price
// panel, same as the plain SMA/EMA lines do, so there's no second panel to
// mirror onto.
function pushCrossoverTraces(traces, events, { oscillatorYAxis, oscillatorField, legendPrefix }) {
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

    if (oscillatorYAxis) {
      traces.push({
        type: 'scatter',
        mode: 'markers',
        name: isBullish ? 'Bullish Crossover' : 'Bearish Crossover',
        x: [toPlotlyDate(event.timestamp)],
        y: [event.value[oscillatorField]],
        marker,
        showlegend: false,
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
      pushCrossoverTraces(traces, events, { oscillatorYAxis: showMacd ? yAxisKeyFor('macd') : null, oscillatorField: 'macd', legendPrefix: 'macdcross' })
    }

    if (indicatorConfig.tsiCrossover.enabled) {
      const { longPeriod, shortPeriod, signalPeriod } = indicatorConfig.tsiCrossover
      const events = indicatorSeries[`TSICROSS:${longPeriod}:${shortPeriod}:${signalPeriod}`] || []
      pushCrossoverTraces(traces, events, { oscillatorYAxis: showTsi ? yAxisKeyFor('tsi') : null, oscillatorField: 'tsi', legendPrefix: 'tsicross' })
    }

    if (indicatorConfig.stochRsiCrossover.enabled) {
      const { rsiPeriod, stochasticPeriod, kPeriod, dPeriod } = indicatorConfig.stochRsiCrossover
      const events = indicatorSeries[`STOCHRSICROSS:${rsiPeriod}:${stochasticPeriod}:${kPeriod}:${dPeriod}`] || []
      pushCrossoverTraces(traces, events, { oscillatorYAxis: showStochRsi ? yAxisKeyFor('stochRsi') : null, oscillatorField: 'k', legendPrefix: 'stochrsicross' })
    }

    if (indicatorConfig.adxCrossover.enabled) {
      const events = indicatorSeries[`ADXCROSS:${indicatorConfig.adxCrossover.period}`] || []
      pushCrossoverTraces(traces, events, { oscillatorYAxis: showAdx ? yAxisKeyFor('adx') : null, oscillatorField: 'pdi', legendPrefix: 'adxcross' })
    }

    // SMA/EMA crossovers overlay the price panel only (both lines are
    // already price-scale, same as the plain SMA/EMA lines) - no
    // oscillator panel to mirror onto, so oscillatorYAxis is always null.
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
