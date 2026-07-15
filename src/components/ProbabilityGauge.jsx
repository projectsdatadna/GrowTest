/**
 * Circular bull/bear gauge, derived from sentiment+confidence
 * (see computeProbabilityGauge in greekAnalysisUtils.js) - not a separate
 * AI call, just a visual split of the existing sentiment/confidence fields.
 */
function ProbabilityGauge({ bullishPct, bearishPct }) {
  const bullish = Math.round(bullishPct)
  const bearish = Math.round(bearishPct)
  const leaning = bullish >= bearish ? 'Bullish' : 'Bearish'

  return (
    <div className="glass-panel p-md rounded-xl flex flex-col items-center justify-center gap-md">
      <h4 className="text-xs font-medium text-on-surface-variant uppercase w-full">Probability Gauge</h4>
      <div className="relative w-32 h-32">
        <svg className="w-full h-full -rotate-90" viewBox="0 0 36 36">
          <path
            d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
            fill="none"
            stroke="#FF5B6E"
            strokeDasharray="100, 100"
            strokeWidth="3"
          />
          <path
            d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
            fill="none"
            stroke="#27D67B"
            strokeDasharray={`${bullish}, 100`}
            strokeWidth="3"
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-bold text-white">{leaning === 'Bullish' ? bullish : bearish}%</span>
          <span className={`text-[10px] uppercase font-bold ${leaning === 'Bullish' ? 'text-bullish' : 'text-bearish'}`}>
            {leaning}
          </span>
        </div>
      </div>
      <div className="flex justify-between w-full text-xs">
        <div className="flex items-center gap-xs">
          <div className="w-2 h-2 bg-bullish rounded-full" />
          <span className="text-on-surface-variant">{bullish}% Bull</span>
        </div>
        <div className="flex items-center gap-xs">
          <div className="w-2 h-2 bg-bearish rounded-full" />
          <span className="text-on-surface-variant">{bearish}% Bear</span>
        </div>
      </div>
    </div>
  )
}

export default ProbabilityGauge
