import { useState, useEffect } from 'react'
import { setAccessToken } from '../services/api'
import './AuthForm.css'

function AuthForm({ onAuthenticate }) {
  const [token, setToken] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // Auto-populate from environment variables on mount
  useEffect(() => {
    const envToken = import.meta.env.VITE_GROWW_API_KEY

    if (envToken) {
      setToken(envToken)
      // Auto-login with env token
      handleAutoLogin(envToken)
    }
  }, [])

  const handleAutoLogin = async (tokenValue) => {
    setLoading(true)
    try {
      setAccessToken(tokenValue)
      onAuthenticate(tokenValue)
    } catch (err) {
      setError(err.message || 'Authentication failed.')
      setLoading(false)
    }
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')

    if (!token.trim()) {
      setError('Please enter your API token')
      return
    }

    setLoading(true)
    try {
      setAccessToken(token)
      onAuthenticate(token)
    } catch (err) {
      setError(err.message || 'Authentication failed.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="auth-container">
      <div className="auth-card">
        <h2>📈 Groww Trading Dashboard</h2>
        <p className="subtitle">Enter your Groww API Token</p>

        {loading && <div className="loading-message">Authenticating...</div>}

        {!loading && (
          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label htmlFor="token">API Token</label>
              <textarea
                id="token"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Paste your Groww API token here"
                disabled={loading}
                rows="6"
              />
            </div>

            {error && <div className="error-message">{error}</div>}

            <button type="submit" disabled={loading} className="submit-btn">
              {loading ? 'Authenticating...' : 'Login'}
            </button>
          </form>
        )}

        <div className="info-box">
          <p>
            Get your API token from{' '}
            <a href="https://groww.in" target="_blank" rel="noopener noreferrer">
              Groww Cloud API Keys Page
            </a>
          </p>
          <p style={{ marginTop: '10px', fontSize: '12px' }}>
            Note: Tokens expire daily at 6:00 AM IST. Provide a fresh token if you get authentication errors.
          </p>
        </div>
      </div>
    </div>
  )
}

export default AuthForm
