/**
 * Renders the institutional-grade Master Prompt AI report: 7 independently
 * null-guarded sections (oi_structure, institutional_positioning,
 * greeks_structure, oi_migration, iv_analysis, market_summary,
 * strategy_recommendations). Used by AnalysisSnapshotCard (one snapshot's
 * own report) and, via the named OiMigrationSection export, by
 * ComparisonPanel (just the migration section, for the compact Difference/
 * Trend Inference slot).
 */

import { splitNarrativePoints } from './greekAnalysisUtils'

function SectionCard({ title, borderClass = 'border-primary-container', children }) {
  return (
    <div className={`p-base bg-white/5 rounded border-l-4 ${borderClass} flex flex-col gap-xs`}>
      <div className="text-lg font-extrabold uppercase text-center text-white tracking-wide mb-xs">{title}</div>
      {children}
    </div>
  )
}

function Field({ label, value }) {
  if (value === null || value === undefined || value === '') return null
  return (
    <div className="flex justify-between gap-md text-xs">
      <span className="text-on-surface-variant">{label}</span>
      <span className="text-on-surface text-right">{value}</span>
    </div>
  )
}

function ListField({ label, items }) {
  if (!Array.isArray(items) || items.length === 0) return null
  return (
    <div className="text-xs">
      <div className="text-on-surface-variant mb-xs">{label}</div>
      <ul className="list-disc pl-lg flex flex-col gap-0.5 text-on-surface">
        {items.map((item, idx) => (
          <li key={idx}>{typeof item === 'string' ? item : JSON.stringify(item)}</li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Renders a free-text AI narrative/summary field - these are plain strings
 * in the schema, but the model frequently numbers or bullets its points
 * within them (see splitNarrativePoints), so this renders those as real
 * list items instead of one run-on paragraph, falling back to a plain
 * paragraph for genuine single-sentence prose.
 */
export function NarrativeText({ text, className = 'text-sm text-on-surface' }) {
  if (!text) return null
  const split = splitNarrativePoints(text)
  if (!split) return <p className={`whitespace-pre-line ${className}`}>{text}</p>
  const ListTag = split.type === 'numbered' ? 'ol' : 'ul'
  return (
    <ListTag
      className={`${split.type === 'numbered' ? 'list-decimal' : 'list-disc'} pl-lg flex flex-col gap-sm whitespace-pre-line ${className}`}
    >
      {split.points.map((point, idx) => (
        <li key={idx}>{point}</li>
      ))}
    </ListTag>
  )
}

function sentimentColorClass(sentiment) {
  const s = (sentiment || '').toLowerCase()
  if (s.includes('bull')) return 'text-bullish'
  if (s.includes('bear')) return 'text-bearish'
  return 'text-tertiary'
}

export function OiMigrationSection({ data }) {
  if (!data) {
    return <div className="text-on-surface-variant text-sm text-center py-lg">Comparison appears once there are two snapshots to compare.</div>
  }

  if (!data.available) {
    return (
      <div className="text-on-surface-variant text-sm text-center py-lg">
        {data.summary || 'No previous snapshot available - based on the current snapshot only.'}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-sm text-sm">
      <div className="flex justify-between border-b border-terminal-border/30 pb-xs">
        <span className="text-on-surface-variant">Market Shift</span>
        <span className={`font-bold ${sentimentColorClass(data.market_shift)}`}>{data.market_shift}</span>
      </div>
      <Field label="Support Shift" value={data.support_shift} />
      <Field label="Resistance Shift" value={data.resistance_shift} />
      <ListField label="Fresh Call Writing" items={data.fresh_call_writing} />
      <ListField label="Fresh Put Writing" items={data.fresh_put_writing} />
      <ListField label="Short Covering" items={data.short_covering} />
      <ListField label="Long Unwinding" items={data.long_unwinding} />
      <ListField label="Important Changes" items={data.important_changes} />
      <NarrativeText text={data.summary} className="text-on-surface-variant" />
    </div>
  )
}

function InstitutionalAnalysisReport({ sections }) {
  if (!sections) return null

  const { oi_structure, institutional_positioning, greeks_structure, oi_migration, iv_analysis, market_summary, strategy_recommendations } = sections

  // Snapshots saved before the institutional report existed only have the
  // old flat shape ({sentiment, support_level, strategy, ...}) - render what
  // they actually have instead of a blank section.
  const hasNewSchema =
    market_summary || oi_structure || institutional_positioning || greeks_structure || iv_analysis || oi_migration || strategy_recommendations

  if (!hasNewSchema) {
    const { sentiment, confidence, support_level, resistance_level, strategy, risk_assessment, detail_analysis } = sections
    if (!sentiment && !strategy && !risk_assessment) return null

    return (
      <div className="flex flex-col gap-md">
        <div className="text-[11px] text-tertiary italic px-xs">
          Classic report format (saved before the institutional analysis upgrade) - newer snapshots include a fuller breakdown
          (OI Structure, Institutional Positioning, Greeks Structure, IV Analysis, Strategy Recommendations, OI Migration).
        </div>
        <SectionCard title="Market Summary" borderClass="border-primary">
          <div className="flex justify-between border-b border-terminal-border/30 pb-xs">
            <span className="text-on-surface-variant text-xs">Sentiment</span>
            <span className={`font-bold text-sm ${sentimentColorClass(sentiment)}`}>{sentiment}</span>
          </div>
          <Field label="Confidence" value={confidence != null ? `${confidence}%` : null} />
          <Field label="Support" value={support_level ? `₹${support_level}` : null} />
          <Field label="Resistance" value={resistance_level ? `₹${resistance_level}` : null} />
          <NarrativeText text={detail_analysis} />
        </SectionCard>
        {strategy && (
          <SectionCard title="Recommended Strategy" borderClass="border-bullish">
            <NarrativeText text={strategy} />
          </SectionCard>
        )}
        {risk_assessment && (
          <SectionCard title="Risk Assessment" borderClass="border-tertiary">
            <NarrativeText text={risk_assessment} />
          </SectionCard>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-md">
      {market_summary && (
        <SectionCard title="Market Summary" borderClass="border-primary">
          <div className="flex justify-between border-b border-terminal-border/30 pb-xs">
            <span className="text-on-surface-variant text-xs">Sentiment</span>
            <span className={`font-bold text-sm ${sentimentColorClass(market_summary.sentiment)}`}>{market_summary.sentiment}</span>
          </div>
          <Field label="Confidence" value={market_summary.confidence != null ? `${market_summary.confidence}%` : null} />
          <Field label="Support" value={market_summary.support_level ? `₹${market_summary.support_level}` : null} />
          <Field label="Resistance" value={market_summary.resistance_level ? `₹${market_summary.resistance_level}` : null} />
          <Field label="Expected Range" value={market_summary.expected_range} />
          <Field label="Smart Money Activity" value={market_summary.smart_money_activity} />
          <ListField label="Key Risks" items={market_summary.key_risks} />
          <NarrativeText text={market_summary.narrative} />
        </SectionCard>
      )}

      {strategy_recommendations && Array.isArray(strategy_recommendations) && strategy_recommendations.length > 0 && (
        <SectionCard title="Strategy Recommendations" borderClass="border-bullish">
          <div className="flex flex-col gap-sm">
            {strategy_recommendations.map((rec, idx) => (
              <div key={idx} className="text-sm">
                <div className="font-bold text-on-surface">{rec.strategy}</div>
                {rec.rationale && <div className="text-xs text-on-surface-variant">{rec.rationale}</div>}
                {rec.risk_level && <div className="text-[11px] text-tertiary uppercase mt-0.5">Risk: {rec.risk_level}</div>}
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      {oi_structure && (
        <SectionCard title="OI Structure Analysis">
          <Field label="Market Sentiment" value={oi_structure.market_sentiment} />
          <ListField label="Support Levels" items={oi_structure.support_levels} />
          <ListField label="Resistance Levels" items={oi_structure.resistance_levels} />
          <ListField label="OI Clusters" items={oi_structure.oi_clusters} />
          <Field label="Range Expectation" value={oi_structure.range_expectation} />
          <Field label="Institutional Defense" value={oi_structure.institutional_defense} />
          <ListField label="Observations" items={oi_structure.observations} />
          <Field label="Confidence" value={oi_structure.confidence} />
        </SectionCard>
      )}

      {institutional_positioning && (
        <SectionCard title="Institutional Positioning">
          <Field label="Overall Bias" value={institutional_positioning.overall_bias} />
          <ListField label="Institutional Activity" items={institutional_positioning.institutional_activity} />
          <ListField label="Bullish Evidence" items={institutional_positioning.bullish_evidence} />
          <ListField label="Bearish Evidence" items={institutional_positioning.bearish_evidence} />
          <ListField label="Hedging Activity" items={institutional_positioning.hedging_activity} />
          <ListField label="Important Strikes" items={institutional_positioning.important_strikes} />
          <NarrativeText text={institutional_positioning.summary} />
        </SectionCard>
      )}

      {greeks_structure && (
        <SectionCard title="Greeks Structure">
          <Field label="Overall Greeks Bias" value={greeks_structure.overall_greeks_bias} />
          <ListField label="Gamma Walls" items={greeks_structure.gamma_walls} />
          <ListField label="High Delta Strikes" items={greeks_structure.high_delta_strikes} />
          <ListField label="Theta Decay Strikes" items={greeks_structure.theta_decay_strikes} />
          <ListField label="Vega Hotspots" items={greeks_structure.vega_hotspots} />
          <Field label="IV Skew" value={greeks_structure.iv_skew} />
          <ListField label="Key Observations" items={greeks_structure.key_observations} />
          <NarrativeText text={greeks_structure.risk_summary} />
        </SectionCard>
      )}

      {iv_analysis && (
        <SectionCard title="IV & Premium Analysis">
          <Field label="Volatility Bias" value={iv_analysis.volatility_bias} />
          <Field label="Premium Status" value={iv_analysis.premium_status} />
          <Field label="IV Skew" value={iv_analysis.iv_skew} />
          <Field label="ATM Analysis" value={iv_analysis.atm_analysis} />
          <Field label="Buyer Advantage" value={iv_analysis.buyer_advantage} />
          <Field label="Seller Advantage" value={iv_analysis.seller_advantage} />
          <Field label="Expected Volatility" value={iv_analysis.expected_volatility} />
          <ListField label="Recommended Strategies" items={iv_analysis.recommended_strategies} />
          <NarrativeText text={iv_analysis.summary} />
        </SectionCard>
      )}

      {oi_migration && (
        <SectionCard title="OI Change & Migration" borderClass="border-tertiary">
          <OiMigrationSection data={oi_migration} />
        </SectionCard>
      )}
    </div>
  )
}

export default InstitutionalAnalysisReport
