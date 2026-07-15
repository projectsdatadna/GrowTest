/**
 * Renders one OI-change panel (Key Strike Changes / Top OI Buildup Calls /
 * Top OI Buildup Puts). Rows come from computeOiChanges() in
 * greekAnalysisUtils.js - real OI deltas between the previous and latest
 * snapshot, not fabricated.
 */
function OiBuildupPanel({ title, rows, barColorClass = 'bg-bullish', formatLabel }) {
  const maxAbsChange = Math.max(1, ...rows.map((r) => Math.abs(r.oiChange)))

  return (
    <div className="glass-panel p-md rounded-xl">
      <h4 className="text-xs font-medium text-on-surface-variant uppercase mb-md">{title}</h4>
      {rows.length === 0 ? (
        <div className="text-on-surface-variant text-sm">No data yet - appears after the next refresh cycle.</div>
      ) : (
        <div className="flex flex-col gap-md">
          {rows.map((row, idx) => {
            const widthPct = Math.min(100, (Math.abs(row.oiChange) / maxAbsChange) * 100)
            const isPositive = row.oiChange >= 0
            return (
              <div key={idx} className="space-y-base">
                <div className="flex justify-between text-xs">
                  <span>{formatLabel ? formatLabel(row) : `${row.strike} ${row.type}`}</span>
                  <span className={isPositive ? 'text-bullish' : 'text-bearish'}>
                    {isPositive ? '+' : ''}
                    {row.oiChange.toLocaleString()}
                  </span>
                </div>
                <div className="h-2 w-full bg-surface-container-high rounded-full overflow-hidden">
                  <div
                    className={`h-full ${isPositive ? barColorClass : 'bg-bearish'}`}
                    style={{ width: `${widthPct}%` }}
                  />
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default OiBuildupPanel
