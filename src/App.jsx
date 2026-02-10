import { useState, useEffect } from 'react'
import { setAccessToken } from './services/api'
import AuthForm from './components/AuthForm'
import InstrumentList from './components/InstrumentList'
import Dashboard from './components/Dashboard'
import AIAnalysis from './components/AIAnalysis'
import './App.css'

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [selectedInstrument, setSelectedInstrument] = useState(null)
  const [refreshInterval, setRefreshInterval] = useState(30000) // 30 seconds default
  const [activeTab, setActiveTab] = useState('dashboard') // 'dashboard' or 'ai-analysis'

  const handleAuthenticate = (accessToken) => {
    setAccessToken(accessToken)
    localStorage.setItem('accessToken', accessToken)
    setIsAuthenticated(true)
  }

  const handleLogout = () => {
    setIsAuthenticated(false)
    setSelectedInstrument(null)
    localStorage.removeItem('accessToken')
  }

  useEffect(() => {
    const savedAccessToken = localStorage.getItem('accessToken')
    if (savedAccessToken) {
      setAccessToken(savedAccessToken)
      setIsAuthenticated(true)
    }
  }, [])

  return (
    <div className="app">
      <header className="app-header">
        <h1>📊 Groww Trading Dashboard</h1>
        {isAuthenticated && (
          <button onClick={handleLogout} className="logout-btn">
            Logout
          </button>
        )}
      </header>

      <main className="app-main">
        {!isAuthenticated ? (
          <AuthForm onAuthenticate={handleAuthenticate} />
        ) : (
          <div className="dashboard-container">
            {/* Sidebar commented out for now */}
            {/* <div className="sidebar">
              <InstrumentList
                onSelectInstrument={setSelectedInstrument}
                selectedInstrument={selectedInstrument}
              />
            </div> */}
            <div className="content">
              {/* Tab navigation commented out for now */}
              {/* <div className="tab-navigation">
                <button
                  className={`tab-btn ${activeTab === 'dashboard' ? 'active' : ''}`}
                  onClick={() => setActiveTab('dashboard')}
                >
                  📊 Dashboard
                </button>
                <button
                  className={`tab-btn ${activeTab === 'ai-analysis' ? 'active' : ''}`}
                  onClick={() => setActiveTab('ai-analysis')}
                >
                  🤖 AI Analysis
                </button>
              </div> */}

              {/* Show AI Analysis by default */}
              <AIAnalysis />
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

export default App
