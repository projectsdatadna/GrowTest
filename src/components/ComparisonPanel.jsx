/**
 * Renders an AI-generated trend comparison between two Greek Analysis
 * snapshots: the parsed_comparison summary plus a per-Greek average-change
 * table. Shared by GreekAnalysis.jsx (auto-refresh "Difference" panel) and
 * CompareSnapshots.jsx (manual compare of any two saved snapshots).
 */
function ComparisonPanel({
  comparing,
  comparisonError,
  comparison,
  greeksDelta,
  title = 'Difference',
  emptyMessage = 'Comparison appears once there are two snapshots to compare.',
}) {
  return (
    <div className="glass-panel rounded-xl overflow-hidden">
      <div className="p-md border-b border-terminal-border bg-white/5">
        <h3 className="text-base font-bold text-white">{title}</h3>
      </div>
      <div className="p-md flex flex-col gap-md">
        {comparing ? (
          <div className="text-on-surface-variant text-sm text-center py-lg">Generating comparison inference...</div>
        ) : comparisonError ? (
          <div className="text-bearish text-sm">{comparisonError}</div>
        ) : !comparison ? (
          <div className="text-on-surface-variant text-sm text-center py-lg">{emptyMessage}</div>
        ) : (
          <>
            {comparison?.parsed_comparison && (
              <div className="flex flex-col gap-base text-sm">
                <div className="flex justify-between border-b border-terminal-border/30 pb-xs">
                  <span className="text-on-surface-variant">Trend</span>
                  <span
                    className={`font-bold ${
                      comparison.parsed_comparison.trend?.toLowerCase().includes('strength')
                        ? 'text-bullish'
                        : comparison.parsed_comparison.trend?.toLowerCase().includes('revers') ||
                          comparison.parsed_comparison.trend?.toLowerCase().includes('weak')
                        ? 'text-bearish'
                        : 'text-tertiary'
                    }`}
                  >
                    {comparison.parsed_comparison.trend}
                  </span>
                </div>
                {comparison.parsed_comparison.confidence && (
                  <div className="flex justify-between border-b border-terminal-border/30 pb-xs">
                    <span className="text-on-surface-variant">Confidence</span>
                    <span className="text-on-surface">{comparison.parsed_comparison.confidence}%</span>
                  </div>
                )}
                {comparison.parsed_comparison.ltp_change_summary && (
                  <p className="text-on-surface-variant">{comparison.parsed_comparison.ltp_change_summary}</p>
                )}
              </div>
            )}

            {greeksDelta.length > 0 && (
              <table className="w-full text-xs mt-base">
                <thead>
                  <tr className="text-on-surface-variant text-left border-b border-terminal-border">
                    <th className="pb-sm font-medium">Change (avg)</th>
                    <th className="pb-sm font-medium text-right">Reason</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-terminal-border/50">
                  {greeksDelta.map((g) => (
                    <tr key={g.key}>
                      <td className="py-sm">
                        <div className="flex items-center gap-base">
                          <span
                            className={`material-symbols-outlined text-base ${
                              g.avgChange >= 0 ? 'text-bullish' : 'text-bearish'
                            }`}
                          >
                            {g.avgChange >= 0 ? 'trending_up' : 'trending_down'}
                          </span>
                          <div>
                            <div className={`font-mono ${g.avgChange >= 0 ? 'text-bullish' : 'text-bearish'}`}>
                              {g.avgChange >= 0 ? '+' : ''}
                              {g.avgChange.toFixed(4)}
                            </div>
                            <div className="text-[10px] opacity-60">{g.label}</div>
                          </div>
                        </div>
                      </td>
                      <td className="py-sm text-right text-on-surface-variant">{g.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>
    </div>
  )
}

export default ComparisonPanel
