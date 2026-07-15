/**
 * Hand-rolled inline SVG line chart of underlying LTP over the refresh
 * history (real data - one point appended per successful refresh; capped
 * rolling window, see ltpHistory in GreekAnalysis.jsx). No charting library,
 * matching the Stitch mockup's own approach.
 */
function TimelineChart({ history }) {
  const points = history || []

  if (points.length < 2) {
    return (
      <div className="glass-panel p-md rounded-xl flex flex-col gap-md">
        <h4 className="text-xs font-medium text-on-surface-variant uppercase">Timeline</h4>
        <div className="flex-1 min-h-[150px] flex items-center justify-center text-on-surface-variant text-sm text-center px-md">
          Not enough refresh history yet - the timeline fills in as auto-refresh cycles happen.
        </div>
      </div>
    )
  }

  const width = 400
  const height = 150
  const ltps = points.map((p) => p.ltp)
  const min = Math.min(...ltps)
  const max = Math.max(...ltps)
  const range = max - min || 1

  const coords = points.map((p, i) => {
    const x = points.length === 1 ? 0 : (i / (points.length - 1)) * width
    const y = height - ((p.ltp - min) / range) * (height - 20) - 10
    return { x, y }
  })

  const pathD = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(' ')

  const tickCount = Math.min(5, points.length)
  const tickIndices = Array.from({ length: tickCount }, (_, i) =>
    Math.round((i / (tickCount - 1 || 1)) * (points.length - 1))
  )

  return (
    <div className="glass-panel p-md rounded-xl flex flex-col gap-md">
      <h4 className="text-xs font-medium text-on-surface-variant uppercase">Timeline</h4>
      <div className="flex-1 relative min-h-[150px]">
        <svg className="w-full h-full glow-line" viewBox={`0 0 ${width} ${height}`}>
          <path d={pathD} fill="none" stroke="#27D67B" strokeWidth="3" />
          {coords.map((c, i) => (
            <circle key={i} cx={c.x} cy={c.y} r="4" fill="#27D67B" />
          ))}
        </svg>
      </div>
      <div className="flex justify-between text-xs text-on-surface-variant font-mono">
        {tickIndices.map((idx) => (
          <span key={idx}>{points[idx].time.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' })}</span>
        ))}
      </div>
    </div>
  )
}

export default TimelineChart
