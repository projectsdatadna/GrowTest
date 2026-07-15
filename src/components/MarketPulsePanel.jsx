const PULSE_METRICS = [
  { key: 'price_strength', label: 'Price Strength', icon: 'bolt' },
  { key: 'momentum', label: 'Momentum', icon: 'speed' },
  { key: 'volatility_score', label: 'Volatility', icon: 'motion_sensor_active' },
  { key: 'buying_pressure', label: 'Buying Pressure', icon: 'shopping_cart' },
  { key: 'selling_pressure', label: 'Selling Pressure', icon: 'sell' },
  { key: 'institutional_activity', label: 'Institutional Activity', icon: 'account_balance' },
]

function StarRating({ score }) {
  const filled = Math.round(Math.min(100, Math.max(0, score || 0)) / 20)
  return (
    <div className="flex gap-xs pb-1">
      {[0, 1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className={`material-symbols-outlined text-[14px] ${i < filled ? 'text-primary' : 'text-on-surface-variant'}`}
          style={i < filled ? { fontVariationSettings: "'FILL' 1" } : undefined}
        >
          star
        </span>
      ))}
    </div>
  )
}

/**
 * "Market Pulse" - six 0-100 scores that come directly from Claude's own
 * analysis of the option chain data (same prompt that produces sentiment/
 * confidence), not a locally invented formula. See parsed_analysis.* in
 * the /analyze-option-chain-range response.
 */
function MarketPulsePanel({ parsedAnalysis }) {
  return (
    <div className="glass-panel p-md rounded-xl">
      <div className="flex justify-between items-center mb-md">
        <h3 className="text-lg font-bold text-white">Market Pulse</h3>
        <div className="text-xs text-on-surface-variant">AI-derived from option chain data</div>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-md">
        {PULSE_METRICS.map((metric) => {
          const score = parsedAnalysis?.[metric.key]
          const hasScore = typeof score === 'number'
          return (
            <div key={metric.key} className="bg-white/5 p-md rounded-lg border border-terminal-border/30">
              <div className="flex items-center gap-base mb-base text-primary">
                <span className="material-symbols-outlined text-[20px]">{metric.icon}</span>
                <span className="text-xs font-medium uppercase text-on-surface-variant">{metric.label}</span>
              </div>
              <div className="flex justify-between items-end">
                <div className="text-2xl font-bold text-on-surface">{hasScore ? Math.round(score) : 'N/A'}</div>
                <StarRating score={score} />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default MarketPulsePanel
