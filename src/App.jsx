import { useState } from 'react'
import AppShell from './components/AppShell'
import AIAnalysis from './components/AIAnalysis'
import GreekAnalysis from './components/GreekAnalysis'

function App() {
  const [activeTab, setActiveTab] = useState('ai-analysis') // 'ai-analysis' or 'greek-analysis'

  return (
    <AppShell activeTab={activeTab} onTabChange={setActiveTab}>
      {activeTab === 'ai-analysis' ? (
        <div className="bg-background min-h-[calc(100vh-96px)] -m-xl p-xl">
          <AIAnalysis />
        </div>
      ) : (
        <GreekAnalysis />
      )}
    </AppShell>
  )
}

export default App
