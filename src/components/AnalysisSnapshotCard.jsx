/**
 * Renders one Greek Analysis snapshot (range + full per-strike Greeks table
 * + AI result) in the dark "terminal" theme. Shared by GreekAnalysis.jsx's
 * "latest" and "previous" zones so the two don't duplicate this markup.
 */
function AnalysisSnapshotCard({ analysis, label, variant = 'latest', timestamp }) {
  if (!analysis) return null

  const strikeRows = Object.keys(analysis.filtered_strikes)
    .map(parseFloat)
    .sort((a, b) => a - b)
    .flatMap((strike) => {
      const data = analysis.filtered_strikes[strike.toString()]
      const rows = []
      if (data?.CE) rows.push({ strike, type: 'CE', ...data.CE })
      if (data?.PE) rows.push({ strike, type: 'PE', ...data.PE })
      return rows
    })

  const isPrevious = variant === 'previous'

  return (
    <div className={`glass-panel rounded-xl overflow-hidden flex flex-col gap-md ${isPrevious ? 'opacity-85' : ''}`}>
      <div className={`p-md border-b border-terminal-border flex justify-between items-baseline ${isPrevious ? 'bg-white/5' : 'bg-primary/10'}`}>
        <h3 className={`text-base font-bold ${isPrevious ? 'text-on-surface-variant' : 'text-white'}`}>{label}</h3>
        {timestamp && (
          <span className="text-[11px] text-on-surface-variant whitespace-nowrap">
            as of {timestamp.toLocaleTimeString('en-US', { hour12: false })}
          </span>
        )}
      </div>

      <div className="px-md grid grid-cols-1 gap-base">
        <div className="bg-white/5 p-base rounded-lg border-l-4 border-bearish">
          <div className="text-[10px] uppercase text-on-surface-variant">Minimum (LTP - {analysis.points_range})</div>
          <div className="text-lg font-bold text-bearish font-mono">₹{analysis.calculated_range?.min}</div>
        </div>
        <div className="bg-white/5 p-base rounded-lg border-l-4 border-primary">
          <div className="text-[10px] uppercase text-on-surface-variant">Current LTP</div>
          <div className="text-lg font-bold text-primary font-mono">₹{analysis.underlying_ltp}</div>
        </div>
        <div className="bg-white/5 p-base rounded-lg border-l-4 border-bullish">
          <div className="text-[10px] uppercase text-on-surface-variant">Maximum (LTP + {analysis.points_range})</div>
          <div className="text-lg font-bold text-bullish font-mono">₹{analysis.calculated_range?.max}</div>
        </div>
      </div>

      <div className="px-md">
        <h4 className="text-xs font-medium text-on-surface-variant uppercase mb-base">
          CE &amp; PE Greeks ({analysis.filtered_strikes_count} strikes)
        </h4>
        <div className="overflow-auto max-h-[320px] custom-scrollbar">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-surface-container-low">
              <tr className="text-on-surface-variant text-left border-b border-terminal-border">
                <th className="py-sm pr-sm font-medium">Strike</th>
                <th className="py-sm pr-sm font-medium">Type</th>
                <th className="py-sm pr-sm font-medium text-right">LTP</th>
                <th className="py-sm pr-sm font-medium text-right">OI</th>
                <th className="py-sm pr-sm font-medium text-right">Delta</th>
                <th className="py-sm pr-sm font-medium text-right">Gamma</th>
                <th className="py-sm pr-sm font-medium text-right">Theta</th>
                <th className="py-sm pr-sm font-medium text-right">Vega</th>
                <th className="py-sm pr-sm font-medium text-right">Rho</th>
                <th className="py-sm font-medium text-right">IV</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-terminal-border/50">
              {strikeRows.map((row, idx) => (
                <tr key={idx}>
                  <td className="py-sm pr-sm font-mono text-on-surface">₹{row.strike}</td>
                  <td className="py-sm pr-sm">
                    <span
                      className={`px-base py-0.5 rounded text-[10px] font-bold ${
                        row.type === 'CE' ? 'bg-bullish/10 text-bullish' : 'bg-bearish/10 text-bearish'
                      }`}
                    >
                      {row.type}
                    </span>
                  </td>
                  <td className="py-sm pr-sm text-right font-mono text-bullish">₹{row.ltp ?? 'N/A'}</td>
                  <td className="py-sm pr-sm text-right font-mono text-on-surface-variant">{row.open_interest ?? 0}</td>
                  <td className="py-sm pr-sm text-right font-mono text-primary">{row.greeks?.delta?.toFixed(4) ?? 'N/A'}</td>
                  <td className="py-sm pr-sm text-right font-mono text-primary">{row.greeks?.gamma?.toFixed(4) ?? 'N/A'}</td>
                  <td className="py-sm pr-sm text-right font-mono text-primary">{row.greeks?.theta?.toFixed(4) ?? 'N/A'}</td>
                  <td className="py-sm pr-sm text-right font-mono text-primary">{row.greeks?.vega?.toFixed(4) ?? 'N/A'}</td>
                  <td className="py-sm pr-sm text-right font-mono text-primary">{row.greeks?.rho?.toFixed(4) ?? 'N/A'}</td>
                  <td className="py-sm text-right font-mono text-tertiary">{row.greeks?.iv?.toFixed(2) ?? 'N/A'}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="p-md pt-0 flex flex-col gap-md">
        <h4 className="text-xs font-medium text-on-surface-variant uppercase">AI Analysis Result</h4>

        {analysis.raw_text && (
          <div className="bg-primary/5 border-l-4 border-primary rounded p-base text-sm text-on-surface">
            {analysis.raw_text}
          </div>
        )}

        {analysis.parsed_analysis && (
          <div className="flex flex-col gap-md">
            <div className="grid grid-cols-2 gap-base text-xs">
              {analysis.parsed_analysis.sentiment && (
                <div className="flex justify-between border-b border-terminal-border/30 pb-xs">
                  <span className="text-on-surface-variant">Sentiment</span>
                  <span
                    className={`font-bold ${
                      analysis.parsed_analysis.sentiment.toLowerCase() === 'bullish'
                        ? 'text-bullish'
                        : analysis.parsed_analysis.sentiment.toLowerCase() === 'bearish'
                        ? 'text-bearish'
                        : 'text-tertiary'
                    }`}
                  >
                    {analysis.parsed_analysis.sentiment}
                  </span>
                </div>
              )}
              {analysis.parsed_analysis.confidence && (
                <div className="flex justify-between border-b border-terminal-border/30 pb-xs">
                  <span className="text-on-surface-variant">Confidence</span>
                  <span className="text-on-surface">{analysis.parsed_analysis.confidence}%</span>
                </div>
              )}
              {analysis.parsed_analysis.support_level && (
                <div className="flex justify-between border-b border-terminal-border/30 pb-xs">
                  <span className="text-on-surface-variant">Support</span>
                  <span className="text-on-surface font-mono">₹{analysis.parsed_analysis.support_level}</span>
                </div>
              )}
              {analysis.parsed_analysis.resistance_level && (
                <div className="flex justify-between border-b border-terminal-border/30 pb-xs">
                  <span className="text-on-surface-variant">Resistance</span>
                  <span className="text-on-surface font-mono">₹{analysis.parsed_analysis.resistance_level}</span>
                </div>
              )}
            </div>

            {analysis.parsed_analysis.strategy && (
              <div className="p-base bg-white/5 rounded border-l-4 border-primary-container">
                <div className="text-[11px] uppercase text-primary font-bold mb-xs">Recommended Strategy</div>
                <div className="text-sm text-on-surface">{analysis.parsed_analysis.strategy}</div>
              </div>
            )}

            {analysis.parsed_analysis.risk_assessment && (
              <div className="p-base bg-white/5 rounded border-l-4 border-tertiary">
                <div className="text-[11px] uppercase text-tertiary font-bold mb-xs">Risk Assessment</div>
                <div className="text-sm text-on-surface">{analysis.parsed_analysis.risk_assessment}</div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default AnalysisSnapshotCard
