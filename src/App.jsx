import { useState } from 'react'
import AppShell from './components/AppShell'
import GreekAnalysis from './components/GreekAnalysis'
import CompareSnapshots from './components/CompareSnapshots'
import WatchlistTab from './components/WatchlistTab'
import HistoricalChartTab from './components/HistoricalChartTab'
import CrossoverScannerTab from './components/CrossoverScannerTab'
import NotificationsTab from './components/NotificationsTab'
import OverviewTab from './components/OverviewTab'

// Two independent Chart tabs sharing one component - see HistoricalChartTab's
// own `instanceKey` prop and src/store/historicalChartSlice.js's factory for
// how each keeps fully separate symbol/interval/date-range/indicator state.
const ChartPrimary = () => <HistoricalChartTab instanceKey="primary" />
const ChartSecondary = () => <HistoricalChartTab instanceKey="secondary" />

// AI Analysis tab is hidden (not deleted) - src/components/AIAnalysis.jsx
// still exists and can be re-linked from AppShell's NAV_ITEMS if needed.
const TAB_COMPONENTS = {
  'greek-analysis': GreekAnalysis,
  compare: CompareSnapshots,
  watchlist: WatchlistTab,
  chart: ChartPrimary,
  chart2: ChartSecondary,
  'crossover-scanner': CrossoverScannerTab,
  notifications: NotificationsTab,
  overview: OverviewTab,
}

const ACTIVE_TAB_KEY = 'growtest.activeTab'

function App() {
  // The open tab survives a refresh (localStorage; falls back to the default if
  // storage is blocked or holds a tab that no longer exists).
  const [activeTab, setActiveTabState] = useState(() => {
    try {
      const saved = localStorage.getItem(ACTIVE_TAB_KEY)
      return saved && TAB_COMPONENTS[saved] ? saved : 'greek-analysis'
    } catch {
      return 'greek-analysis'
    }
  })
  const setActiveTab = (tab) => {
    setActiveTabState(tab)
    try {
      localStorage.setItem(ACTIVE_TAB_KEY, tab)
    } catch {
      /* storage unavailable - the tab just won't persist */
    }
  }
  const ActiveTabComponent = TAB_COMPONENTS[activeTab] || GreekAnalysis

  return (
    <AppShell activeTab={activeTab} onTabChange={setActiveTab}>
      <ActiveTabComponent onTabChange={setActiveTab} />
    </AppShell>
  )
}

export default App
