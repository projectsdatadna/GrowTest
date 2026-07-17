import InstitutionalAnalysisReport from './InstitutionalAnalysisReport'

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
    .map((strike) => {
      const data = analysis.filtered_strikes[strike.toString()]
      return { strike, ce: data?.CE, pe: data?.PE }
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
              <tr className="border-b border-terminal-border/50">
                <th colSpan={8} className="pb-xs text-center text-bullish font-medium">CALL (CE)</th>
                <th></th>
                <th colSpan={8} className="pb-xs text-center text-bearish font-medium">PUT (PE)</th>
              </tr>
              <tr className="text-on-surface-variant text-left border-b border-terminal-border">
                <th className="py-sm pr-sm pl-sm font-medium text-right bg-bullish/5">LTP</th>
                <th className="py-sm pr-sm font-medium text-right bg-bullish/5">OI</th>
                <th className="py-sm pr-sm font-medium text-right bg-bullish/5">Delta</th>
                <th className="py-sm pr-sm font-medium text-right bg-bullish/5">Gamma</th>
                <th className="py-sm pr-sm font-medium text-right bg-bullish/5">Theta</th>
                <th className="py-sm pr-sm font-medium text-right bg-bullish/5">Vega</th>
                <th className="py-sm pr-sm font-medium text-right bg-bullish/5">Rho</th>
                <th className="py-sm pr-sm font-medium text-right bg-bullish/5">IV</th>
                <th className="py-sm px-md font-medium text-center border-x border-terminal-border">Strike</th>
                <th className="py-sm pr-sm pl-md font-medium text-right bg-bearish/5">LTP</th>
                <th className="py-sm pr-sm font-medium text-right bg-bearish/5">OI</th>
                <th className="py-sm pr-sm font-medium text-right bg-bearish/5">Delta</th>
                <th className="py-sm pr-sm font-medium text-right bg-bearish/5">Gamma</th>
                <th className="py-sm pr-sm font-medium text-right bg-bearish/5">Theta</th>
                <th className="py-sm pr-sm font-medium text-right bg-bearish/5">Vega</th>
                <th className="py-sm pr-sm font-medium text-right bg-bearish/5">Rho</th>
                <th className="py-sm pr-sm font-medium text-right bg-bearish/5">IV</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-terminal-border/50">
              {strikeRows.map((row) => (
                <tr key={row.strike}>
                  <td className="py-sm pr-sm pl-sm text-right font-mono text-bullish bg-bullish/5">{row.ce?.ltp != null ? `₹${row.ce.ltp}` : 'N/A'}</td>
                  <td className="py-sm pr-sm text-right font-mono text-on-surface-variant bg-bullish/5">{row.ce?.open_interest ?? 0}</td>
                  <td className="py-sm pr-sm text-right font-mono text-primary bg-bullish/5">{row.ce?.greeks?.delta?.toFixed(4) ?? 'N/A'}</td>
                  <td className="py-sm pr-sm text-right font-mono text-primary bg-bullish/5">{row.ce?.greeks?.gamma?.toFixed(4) ?? 'N/A'}</td>
                  <td className="py-sm pr-sm text-right font-mono text-primary bg-bullish/5">{row.ce?.greeks?.theta?.toFixed(4) ?? 'N/A'}</td>
                  <td className="py-sm pr-sm text-right font-mono text-primary bg-bullish/5">{row.ce?.greeks?.vega?.toFixed(4) ?? 'N/A'}</td>
                  <td className="py-sm pr-sm text-right font-mono text-primary bg-bullish/5">{row.ce?.greeks?.rho?.toFixed(4) ?? 'N/A'}</td>
                  <td className="py-sm pr-sm text-right font-mono text-tertiary bg-bullish/5">{row.ce?.greeks?.iv?.toFixed(2) ?? 'N/A'}%</td>

                  <td className="py-sm px-md text-center font-mono font-bold text-on-surface border-x border-terminal-border/50 bg-surface-container-low">₹{row.strike}</td>

                  <td className="py-sm pr-sm pl-md text-right font-mono text-bearish bg-bearish/5">{row.pe?.ltp != null ? `₹${row.pe.ltp}` : 'N/A'}</td>
                  <td className="py-sm pr-sm text-right font-mono text-on-surface-variant bg-bearish/5">{row.pe?.open_interest ?? 0}</td>
                  <td className="py-sm pr-sm text-right font-mono text-primary bg-bearish/5">{row.pe?.greeks?.delta?.toFixed(4) ?? 'N/A'}</td>
                  <td className="py-sm pr-sm text-right font-mono text-primary bg-bearish/5">{row.pe?.greeks?.gamma?.toFixed(4) ?? 'N/A'}</td>
                  <td className="py-sm pr-sm text-right font-mono text-primary bg-bearish/5">{row.pe?.greeks?.theta?.toFixed(4) ?? 'N/A'}</td>
                  <td className="py-sm pr-sm text-right font-mono text-primary bg-bearish/5">{row.pe?.greeks?.vega?.toFixed(4) ?? 'N/A'}</td>
                  <td className="py-sm pr-sm text-right font-mono text-primary bg-bearish/5">{row.pe?.greeks?.rho?.toFixed(4) ?? 'N/A'}</td>
                  <td className="py-sm pr-sm text-right font-mono text-tertiary bg-bearish/5">{row.pe?.greeks?.iv?.toFixed(2) ?? 'N/A'}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="p-md pt-0 flex flex-col gap-md">
        <h4 className="text-xs font-medium text-on-surface-variant uppercase">AI Analysis Result</h4>

        {!analysis.parsed_analysis && analysis.raw_text && (
          <div className="bg-bearish/5 border-l-4 border-bearish rounded p-base text-sm text-on-surface">
            <div className="text-[11px] uppercase text-bearish font-bold mb-xs">AI response could not be parsed - raw output</div>
            {analysis.raw_text}
          </div>
        )}

        {analysis.parsed_analysis && <InstitutionalAnalysisReport sections={analysis.parsed_analysis} />}
      </div>
    </div>
  )
}

export default AnalysisSnapshotCard
