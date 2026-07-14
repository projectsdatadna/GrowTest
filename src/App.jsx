import { useState } from 'react'
import AIAnalysis from './components/AIAnalysis'
import GreekAnalysis from './components/GreekAnalysis'
import './App.css'

function App() {
  const [activeTab, setActiveTab] = useState('ai-analysis') // 'ai-analysis' or 'greek-analysis'

  return (
    <div className="app">
      <header className="app-header">
        <h1>📊 Groww Trading Dashboard</h1>
      </header>

      <main className="app-main">
        <div className="dashboard-container">
          <div className="content">
            <div className="tab-navigation">
              <button
                className={`tab-btn ${activeTab === 'ai-analysis' ? 'active' : ''}`}
                onClick={() => setActiveTab('ai-analysis')}
              >
                🤖 AI Analysis
              </button>
              <button
                className={`tab-btn ${activeTab === 'greek-analysis' ? 'active' : ''}`}
                onClick={() => setActiveTab('greek-analysis')}
              >
                📈 Greek Analysis
              </button>
            </div>

            {activeTab === 'ai-analysis' ? <AIAnalysis /> : <GreekAnalysis />}
          </div>
        </div>
      </main>
    </div>
  )
}

export default App
