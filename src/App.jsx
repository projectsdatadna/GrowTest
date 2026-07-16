import { useState } from 'react'
import AppShell from './components/AppShell'
import GreekAnalysis from './components/GreekAnalysis'
import CompareSnapshots from './components/CompareSnapshots'

// AI Analysis tab is hidden (not deleted) - src/components/AIAnalysis.jsx
// still exists and can be re-linked from AppShell's NAV_ITEMS if needed.
function App() {
  const [activeTab, setActiveTab] = useState('greek-analysis')

  return (
    <AppShell activeTab={activeTab} onTabChange={setActiveTab}>
      {activeTab === 'compare' ? <CompareSnapshots /> : <GreekAnalysis />}
    </AppShell>
  )
}

export default App
