import { OiMigrationSection } from './InstitutionalAnalysisReport'
import SummarizedRecommendationsReport from './SummarizedRecommendationsReport'

/**
 * Renders the diff between two snapshots - OI Change & Migration (Master
 * Prompt) or a diff-aware Key Elements/Recommended Trades (Summarized
 * Recommendations, via the same prompt builder extended to accept a
 * previous snapshot) - plus a per-Greek average-change table either way.
 * Shared by GreekAnalysis.jsx (auto-refresh "Difference" panel, fed the
 * latest run's own parsed_analysis) and CompareSnapshots.jsx (manual compare
 * of any two saved snapshots, fed the dedicated comparison call's result).
 */
function ComparisonPanel({
  comparing,
  comparisonError,
  promptType = 'master_prompt',
  oiMigration,
  summarizedSections,
  greeksDelta,
  title = 'Difference',
  emptyMessage = 'Comparison appears once there are two snapshots to compare.',
}) {
  const isSummarized = promptType === 'summarized_recommendations'
  const hasContent = isSummarized ? !!summarizedSections : !!oiMigration
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
        ) : !hasContent ? (
          <div className="text-on-surface-variant text-sm text-center py-lg">{emptyMessage}</div>
        ) : (
          <>
            {isSummarized ? (
              <SummarizedRecommendationsReport sections={summarizedSections} />
            ) : (
              <OiMigrationSection data={oiMigration} />
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
                              g.direction === 'up' ? 'text-bullish' : g.direction === 'down' ? 'text-bearish' : 'text-on-surface-variant'
                            }`}
                          >
                            {g.direction === 'up' ? 'trending_up' : g.direction === 'down' ? 'trending_down' : 'trending_flat'}
                          </span>
                          <div>
                            <div
                              className={`font-mono ${
                                g.direction === 'up' ? 'text-bullish' : g.direction === 'down' ? 'text-bearish' : 'text-on-surface-variant'
                              }`}
                            >
                              {g.direction === 'up' ? '+' : ''}
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
