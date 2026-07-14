import { useState, useRef, useEffect } from 'react'
import { analyzeOptionChainRange } from '../services/api'
import './GreekAnalysis.css'

const AUTO_REFRESH_INTERVAL_MS = 15 * 60 * 1000

function GreekAnalysis() {
  const [formData, setFormData] = useState({
    exchange: 'NSE',
    underlying_symbol: '',
    trading_symbol: '',
    expiry_date: '',
    points_range: '500',
  })

  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [refreshError, setRefreshError] = useState('')
  const [analysis, setAnalysis] = useState(null)
  const [lastUpdated, setLastUpdated] = useState(null)

  const intervalRef = useRef(null)
  const paramsRef = useRef(null)

  useEffect(() => {
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
      }
    }
  }, [])

  const handleInputChange = (e) => {
    const { name, value } = e.target
    setFormData(prev => ({
      ...prev,
      [name]: value
    }))
  }

  const validateForm = () => {
    const { exchange, underlying_symbol, trading_symbol, expiry_date, points_range } = formData

    if (!exchange || !underlying_symbol || !trading_symbol || !expiry_date || points_range === '') {
      setError('All fields are required')
      return false
    }

    const range = parseFloat(points_range)
    if (isNaN(range) || range <= 0) {
      setError('Points range must be a positive number')
      return false
    }

    return true
  }

  const runAnalysis = async (params, { isAutoRefresh = false } = {}) => {
    if (isAutoRefresh) {
      setRefreshing(true)
      setRefreshError('')
    } else {
      setLoading(true)
      setError('')
    }

    try {
      const data = await analyzeOptionChainRange(params)
      setAnalysis(data)
      setLastUpdated(new Date())
    } catch (err) {
      const message = err.response?.data?.error || err.message || 'An error occurred during analysis'
      if (isAutoRefresh) {
        setRefreshError(`Auto-refresh failed: ${message}. Retrying next cycle.`)
      } else {
        setError(message)
      }
    } finally {
      if (isAutoRefresh) {
        setRefreshing(false)
      } else {
        setLoading(false)
      }
    }
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')

    if (!validateForm()) {
      return
    }

    const { exchange, underlying_symbol, trading_symbol, expiry_date, points_range } = formData
    const params = {
      symbol: underlying_symbol,
      underlying_symbol,
      trading_symbol,
      exchange,
      expiry_date,
      points_range: parseFloat(points_range),
    }
    paramsRef.current = params

    await runAnalysis(params)

    if (intervalRef.current) {
      clearInterval(intervalRef.current)
    }
    intervalRef.current = setInterval(() => {
      if (paramsRef.current) {
        runAnalysis(paramsRef.current, { isAutoRefresh: true })
      }
    }, AUTO_REFRESH_INTERVAL_MS)
  }

  const strikeRows = analysis
    ? Object.keys(analysis.filtered_strikes)
        .map(parseFloat)
        .sort((a, b) => a - b)
        .flatMap((strike) => {
          const data = analysis.filtered_strikes[strike.toString()]
          const rows = []
          if (data?.CE) rows.push({ strike, type: 'CE', ...data.CE })
          if (data?.PE) rows.push({ strike, type: 'PE', ...data.PE })
          return rows
        })
    : []

  return (
    <div className="greek-analysis-container">
      <div className="greek-analysis-form-section">
        <h2>Greek Analysis</h2>

        <form onSubmit={handleSubmit} className="greek-analysis-form">
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="ga-exchange">Exchange</label>
              <select
                id="ga-exchange"
                name="exchange"
                value={formData.exchange}
                onChange={handleInputChange}
                className="form-input"
              >
                <option value="NSE">NSE</option>
                <option value="BSE">BSE</option>
              </select>
            </div>

            <div className="form-group">
              <label htmlFor="ga-underlying_symbol">Underlying Symbol</label>
              <input
                id="ga-underlying_symbol"
                type="text"
                name="underlying_symbol"
                value={formData.underlying_symbol}
                onChange={handleInputChange}
                placeholder="e.g., NIFTY"
                className="form-input"
              />
            </div>

            <div className="form-group">
              <label htmlFor="ga-trading_symbol">Trading Symbol</label>
              <input
                id="ga-trading_symbol"
                type="text"
                name="trading_symbol"
                value={formData.trading_symbol}
                onChange={handleInputChange}
                placeholder="e.g., NIFTY24JUL25000CE"
                className="form-input"
              />
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="ga-points_range">Points Range (+/-)</label>
              <input
                id="ga-points_range"
                type="number"
                name="points_range"
                value={formData.points_range}
                onChange={handleInputChange}
                placeholder="e.g., 500"
                step="50"
                min="1"
                className="form-input"
              />
            </div>

            <div className="form-group">
              <label htmlFor="ga-expiry_date">Expiry Date</label>
              <input
                id="ga-expiry_date"
                type="date"
                name="expiry_date"
                value={formData.expiry_date}
                onChange={handleInputChange}
                placeholder="YYYY-MM-DD"
                className="form-input"
              />
            </div>
          </div>

          {error && <div className="error-message">{error}</div>}

          <button type="submit" disabled={loading} className="submit-btn">
            {loading ? 'Analyzing...' : 'Start Greek Analysis'}
          </button>
        </form>
      </div>

      {analysis && (
        <div className="output-column">
          <div className="calculated-range-section">
            <h3>Calculated Range</h3>
            <div className="range-display">
              <div className="range-item min">
                <span className="range-label">Minimum (LTP - {analysis.points_range})</span>
                <span className="range-value min">₹{analysis.calculated_range?.min}</span>
              </div>
              <div className="range-item current">
                <span className="range-label">Current LTP</span>
                <span className="range-value current">₹{analysis.underlying_ltp}</span>
              </div>
              <div className="range-item max">
                <span className="range-label">Maximum (LTP + {analysis.points_range})</span>
                <span className="range-value max">₹{analysis.calculated_range?.max}</span>
              </div>
            </div>

            <div className="refresh-status">
              {lastUpdated && (
                <span>
                  Last updated at {lastUpdated.toLocaleTimeString()} · auto-refreshing every 15 min
                  {refreshing ? ' · refreshing now...' : ''}
                </span>
              )}
              {refreshError && <div className="refresh-error">{refreshError}</div>}
            </div>
          </div>

          <div className="greeks-table-section">
            <h3>CE &amp; PE Greeks ({analysis.filtered_strikes_count} strikes)</h3>
            <div className="options-table">
              <table>
                <thead>
                  <tr>
                    <th>Strike</th>
                    <th>Type</th>
                    <th>LTP</th>
                    <th>OI</th>
                    <th>Delta</th>
                    <th>Gamma</th>
                    <th>Theta</th>
                    <th>Vega</th>
                    <th>Rho</th>
                    <th>IV</th>
                  </tr>
                </thead>
                <tbody>
                  {strikeRows.map((row, idx) => (
                    <tr key={idx}>
                      <td className="strike">₹{row.strike}</td>
                      <td className={`type ${row.type === 'CE' ? 'ce' : 'pe'}`}>{row.type}</td>
                      <td className="ltp">₹{row.ltp ?? 'N/A'}</td>
                      <td className="oi">{row.open_interest ?? 0}</td>
                      <td className="greek">{row.greeks?.delta?.toFixed(4) ?? 'N/A'}</td>
                      <td className="greek">{row.greeks?.gamma?.toFixed(4) ?? 'N/A'}</td>
                      <td className="greek">{row.greeks?.theta?.toFixed(4) ?? 'N/A'}</td>
                      <td className="greek">{row.greeks?.vega?.toFixed(4) ?? 'N/A'}</td>
                      <td className="greek">{row.greeks?.rho?.toFixed(4) ?? 'N/A'}</td>
                      <td className="iv">{row.greeks?.iv?.toFixed(2) ?? 'N/A'}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="analysis-result-section">
            <h3>AI Analysis Result</h3>

            {analysis.raw_text && (
              <div className="analysis-explanation">
                <h4>Analysis Summary</h4>
                <p>{analysis.raw_text}</p>
              </div>
            )}

            {analysis.parsed_analysis && (
              <div className="analysis-details">
                <div className="analysis-grid">
                  {analysis.parsed_analysis.sentiment && (
                    <div className="analysis-item">
                      <span className="label">Sentiment:</span>
                      <span className={`value sentiment-${analysis.parsed_analysis.sentiment.toLowerCase()}`}>
                        {analysis.parsed_analysis.sentiment}
                      </span>
                    </div>
                  )}
                  {analysis.parsed_analysis.support_level && (
                    <div className="analysis-item">
                      <span className="label">Support Level:</span>
                      <span className="value">₹{analysis.parsed_analysis.support_level}</span>
                    </div>
                  )}
                  {analysis.parsed_analysis.resistance_level && (
                    <div className="analysis-item">
                      <span className="label">Resistance Level:</span>
                      <span className="value">₹{analysis.parsed_analysis.resistance_level}</span>
                    </div>
                  )}
                  {analysis.parsed_analysis.confidence && (
                    <div className="analysis-item">
                      <span className="label">Confidence:</span>
                      <span className="value">{analysis.parsed_analysis.confidence}%</span>
                    </div>
                  )}
                </div>

                {analysis.parsed_analysis.strategy && (
                  <div className="analysis-section">
                    <h5>Recommended Strategy</h5>
                    <p>{analysis.parsed_analysis.strategy}</p>
                  </div>
                )}

                {analysis.parsed_analysis.risk_assessment && (
                  <div className="analysis-section">
                    <h5>Risk Assessment</h5>
                    <p>{analysis.parsed_analysis.risk_assessment}</p>
                  </div>
                )}

                {analysis.parsed_analysis.detail_analysis && (
                  <div className="analysis-section">
                    <h5>Detailed Analysis</h5>
                    {typeof analysis.parsed_analysis.detail_analysis === 'object' ? (
                      <div className="detail-analysis-content">
                        {Object.entries(analysis.parsed_analysis.detail_analysis).map(([key, value]) => (
                          <div key={key} className="detail-item">
                            <h6>{key}</h6>
                            <p>{value}</p>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p>{analysis.parsed_analysis.detail_analysis}</p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default GreekAnalysis
