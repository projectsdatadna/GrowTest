/**
 * Renders the "Summarized Recommendations" AI report: a concise key_elements
 * readout plus concrete recommended_trades - the lighter-weight alternative
 * to the institutional Master Prompt report (InstitutionalAnalysisReport.jsx).
 * Used by AnalysisSnapshotCard whenever a snapshot's prompt_type is
 * 'summarized_recommendations'.
 */

import { SectionCard, Field, sentimentColorClass, NarrativeText } from './InstitutionalAnalysisReport'

function levelColorClass(level) {
  const l = (level || '').toLowerCase()
  if (l === 'low') return 'text-bullish'
  if (l === 'high') return 'text-bearish'
  if (l === 'medium') return 'text-tertiary'
  return 'text-on-surface-variant'
}

function KeyElementCard({ element }) {
  if (!element) return null
  return (
    <div className="text-sm border-b border-terminal-border/30 pb-sm last:border-0 last:pb-0">
      {element.title && <div className="font-bold text-on-surface">{element.title}</div>}
      <NarrativeText text={element.observation} className="text-sm text-on-surface" />
      {element.reason && <NarrativeText text={element.reason} className="text-xs text-on-surface-variant mt-0.5" />}
    </div>
  )
}

function RecommendedTradeCard({ trade }) {
  if (!trade) return null
  return (
    <div className="p-base bg-white/5 rounded border-l-4 border-primary-container flex flex-col gap-xs">
      <div className="flex justify-between items-baseline">
        <span className="font-bold text-on-surface">{trade.strategy}</span>
        {trade.market_bias && (
          <span className={`text-xs font-bold uppercase ${sentimentColorClass(trade.market_bias)}`}>{trade.market_bias}</span>
        )}
      </div>
      <NarrativeText text={trade.reason} className="text-xs text-on-surface-variant" />
      <Field label="Suggested Strikes" value={trade.suggested_strikes} />
      {trade.entry && <NarrativeText text={trade.entry} className="text-xs text-on-surface" />}
      <div className="flex justify-between gap-md text-xs pt-xs">
        <span className={`font-bold ${levelColorClass(trade.profit_expectation)}`}>Profit: {trade.profit_expectation || 'N/A'}</span>
        <span className={`font-bold ${levelColorClass(trade.risk)}`}>Risk: {trade.risk || 'N/A'}</span>
        {trade.confidence != null && <span className="text-on-surface-variant">Confidence: {trade.confidence}%</span>}
      </div>
    </div>
  )
}

function SummarizedRecommendationsReport({ sections }) {
  if (!sections) return null

  const { key_elements, recommended_trades } = sections
  const hasKeyElements = Array.isArray(key_elements) && key_elements.length > 0
  const hasTrades = Array.isArray(recommended_trades) && recommended_trades.length > 0

  if (!hasKeyElements && !hasTrades) return null

  return (
    <div className="flex flex-col gap-md">
      {hasKeyElements && (
        <SectionCard title="Key Elements" borderClass="border-primary">
          <div className="flex flex-col gap-sm">
            {key_elements.map((element, idx) => (
              <KeyElementCard key={idx} element={element} />
            ))}
          </div>
        </SectionCard>
      )}

      {hasTrades && (
        <SectionCard title="Recommended Trades" borderClass="border-bullish">
          <div className="flex flex-col gap-sm">
            {recommended_trades.map((trade, idx) => (
              <RecommendedTradeCard key={idx} trade={trade} />
            ))}
          </div>
        </SectionCard>
      )}
    </div>
  )
}

export default SummarizedRecommendationsReport
