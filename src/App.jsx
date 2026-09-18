import { useState } from 'react'
import AppShell from './components/AppShell'
import GreekAnalysis from './components/GreekAnalysis'
import CompareSnapshots from './components/CompareSnapshots'
import WatchlistTab from './components/WatchlistTab'
import HistoricalChartTab from './components/HistoricalChartTab'

// AI Analysis tab is hidden (not deleted) - src/components/AIAnalysis.jsx
// still exists and can be re-linked from AppShell's NAV_ITEMS if needed.
const TAB_COMPONENTS = {
  'greek-analysis': GreekAnalysis,
  compare: CompareSnapshots,
  watchlist: WatchlistTab,
  chart: HistoricalChartTab,
}

function App() {
  const [activeTab, setActiveTab] = useState('greek-analysis')
  const ActiveTabComponent = TAB_COMPONENTS[activeTab] || GreekAnalysis

  return (
    <AppShell activeTab={activeTab} onTabChange={setActiveTab}>
      <ActiveTabComponent />
    </AppShell>
  )
}

export default App
