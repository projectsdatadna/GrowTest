/**
 * Shown when two valid, correctly-compared snapshots genuinely have
 * identical OI/Greeks (e.g. both saved during a stretch where the
 * underlying feed didn't move) - distinguishes "computed a real zero" from
 * "something's broken", since the cards below look the same either way.
 */
function NoChangeBanner() {
  return (
    <div className="glass-panel rounded-xl p-md flex items-start gap-base border-l-4 border-tertiary">
      <span className="material-symbols-outlined text-tertiary">info</span>
      <div className="text-sm text-on-surface-variant">
        <span className="font-bold text-on-surface">No meaningful change detected</span> between these two snapshots - their OI
        and Greeks are effectively identical. Try picking snapshots further apart, or during more active trading hours.
      </div>
    </div>
  )
}

export default NoChangeBanner
