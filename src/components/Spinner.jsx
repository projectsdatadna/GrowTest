/**
 * Small inline loading spinner - plain CSS (Tailwind's animate-spin on a
 * bordered circle), no SVG/library needed. Reusable across tabs, same way
 * TimelineChart/ProbabilityGauge are small shared visual primitives.
 */
function Spinner({ className = '' }) {
  return <span className={`inline-block w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin ${className}`} />
}

export default Spinner
