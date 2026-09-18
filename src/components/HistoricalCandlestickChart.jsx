/**
 * OHLC price chart (Plotly's `ohlc` trace type, per
 * plotly.com/javascript/ohlc-charts/) with up to 4 indicator panels stacked
 * below it - Moving Averages, Bollinger Bands, RSI, MACD - each its own row,
 * none overlaid on the price candles. All rows share Plotly's single
 * default x-axis, so drag-to-zoom/pan stays in sync across every visible
 * row for free (no manual chart-sync code needed, unlike a multi-instance
 * charting library).
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

function toPlotlyDate(timestampSeconds) {
  return new Date(timestampSeconds * 1000)
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

function HistoricalCandlestickChart({ candles, indicatorSeries, indicatorConfig }) {
  const { data, layout } = useMemo(() => {
    const showMovingAvg = indicatorConfig.sma.enabled || indicatorConfig.ema.enabled
    const showBollinger = indicatorConfig.bollingerBands.enabled
    const showRsi = indicatorConfig.rsi.enabled
    const showMacd = indicatorConfig.macd.enabled

    // Order matters: this list's order is the stacking order top-to-bottom
    // below the price row, and its length determines the y-axis each row
    // gets (rows[0] -> 'y2', rows[1] -> 'y3', ...).
    const indicatorRows = [
      showMovingAvg && 'movingAvg',
      showBollinger && 'bollinger',
      showRsi && 'rsi',
      showMacd && 'macd',
    ].filter(Boolean)

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

    const layoutAxes = {
      // Plotly's built-in range slider - the standard mini-navigator strip
      // under the price panel (shown by default on plotly.com's own OHLC
      // chart examples) for dragging to pan/zoom through time without
      // losing the full-range overview. Previously disabled here reasoning
      // it was redundant with the stacked indicator panels below - it isn't.
      xaxis: {
        rangeslider: { visible: true, bgcolor: COLOR_GRID, bordercolor: COLOR_GRID, thickness: 0.08 },
        gridcolor: COLOR_GRID,
        color: COLOR_TEXT,
      },
      yaxis: { domain: priceDomain, gridcolor: COLOR_GRID, color: COLOR_TEXT },
    }
    const annotations = [panelLabel('Price', priceDomain[1])]

    if (showMovingAvg) {
      const yaxis = yAxisKeyFor('movingAvg')
      const axisKey = `yaxis${yaxis.slice(1)}`
      const domain = rowDomains[indicatorRows.indexOf('movingAvg')]
      layoutAxes[axisKey] = { domain, gridcolor: COLOR_GRID, color: COLOR_TEXT }
      annotations.push(panelLabel('Moving Avg', domain[1]))

      if (indicatorConfig.sma.enabled) {
        const points = indicatorSeries[`SMA:${indicatorConfig.sma.period}`] || []
        traces.push({ type: 'scatter', mode: 'lines', name: `SMA ${indicatorConfig.sma.period}`, ...seriesToXY(points), line: { color: COLOR_PRIMARY, width: 1.5 }, xaxis: 'x', yaxis })
      }
      if (indicatorConfig.ema.enabled) {
        const points = indicatorSeries[`EMA:${indicatorConfig.ema.period}`] || []
        traces.push({ type: 'scatter', mode: 'lines', name: `EMA ${indicatorConfig.ema.period}`, ...seriesToXY(points), line: { color: COLOR_SECONDARY, width: 1.5 }, xaxis: 'x', yaxis })
      }
    }

    if (showBollinger) {
      const yaxis = yAxisKeyFor('bollinger')
      const axisKey = `yaxis${yaxis.slice(1)}`
      const domain = rowDomains[indicatorRows.indexOf('bollinger')]
      layoutAxes[axisKey] = { domain, gridcolor: COLOR_GRID, color: COLOR_TEXT }
      annotations.push(panelLabel('Bollinger Bands', domain[1]))

      const { period, stdDev } = indicatorConfig.bollingerBands
      const points = indicatorSeries[`BB:${period}:${stdDev}`] || []
      const x = points.map((p) => toPlotlyDate(p.timestamp))
      traces.push({ type: 'scatter', mode: 'lines', name: 'BB Upper', x, y: points.map((p) => p.value?.upper), line: { color: COLOR_SECONDARY, width: 1 }, xaxis: 'x', yaxis })
      traces.push({ type: 'scatter', mode: 'lines', name: 'BB Middle', x, y: points.map((p) => p.value?.middle), line: { color: COLOR_PRIMARY, width: 1 }, xaxis: 'x', yaxis })
      traces.push({ type: 'scatter', mode: 'lines', name: 'BB Lower', x, y: points.map((p) => p.value?.lower), line: { color: COLOR_DOWN, width: 1 }, xaxis: 'x', yaxis })
    }

    if (showRsi) {
      const yaxis = yAxisKeyFor('rsi')
      const axisKey = `yaxis${yaxis.slice(1)}`
      const domain = rowDomains[indicatorRows.indexOf('rsi')]
      layoutAxes[axisKey] = { domain, range: [0, 100], gridcolor: COLOR_GRID, color: COLOR_TEXT }
      annotations.push(panelLabel('RSI', domain[1]))

      const points = indicatorSeries[`RSI:${indicatorConfig.rsi.period}`] || []
      traces.push({ type: 'scatter', mode: 'lines', name: `RSI ${indicatorConfig.rsi.period}`, ...seriesToXY(points), line: { color: COLOR_PRIMARY, width: 1.5 }, xaxis: 'x', yaxis })

      layoutAxes.shapes = [...(layoutAxes.shapes || []), ...rsiReferenceLines(yaxis)]
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

    return {
      data: traces,
      layout: {
        ...layoutAxes,
        annotations,
        height: plotHeightPx + CHROME_PX,
        autosize: true,
        margin: { l: 45, r: 20, t: 10, b: 30 },
        showlegend: true,
        legend: { orientation: 'h', font: { color: COLOR_TEXT, size: 10 } },
        paper_bgcolor: 'transparent',
        plot_bgcolor: 'transparent',
        font: { color: COLOR_TEXT },
      },
    }
  }, [candles, indicatorSeries, indicatorConfig])

  // No inline height here - layout.height above drives the actual size (it
  // grows as more indicator panels are enabled), autosize + useResizeHandler
  // still keep the width responsive.
  return <Plot data={data} layout={layout} style={{ width: '100%' }} useResizeHandler config={{ displaylogo: false }} />
}

// Dotted 30/70 reference lines for the RSI panel, anchored to that panel's
// own y-axis but spanning the full plot width (xref: 'paper').
function rsiReferenceLines(yaxis) {
  const yref = yaxis
  return [30, 70].map((level) => ({
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

export default HistoricalCandlestickChart
