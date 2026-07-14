import { useState } from 'react'
import './AIAnalysis.css'

function AIAnalysis() {
  const [formData, setFormData] = useState({
    exchange: 'NSE',
    underlying_symbol: '',
    trading_symbol: '',
    calculate_percentage: '',
    expiry_date: '',
  })

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [analysis, setAnalysis] = useState(null)
  const [calculatedRange, setCalculatedRange] = useState(null)

  const handleInputChange = (e) => {
    const { name, value } = e.target
    setFormData(prev => ({
      ...prev,
      [name]: value
    }))
  }

  const validateForm = () => {
    const { exchange, underlying_symbol, trading_symbol, calculate_percentage, expiry_date } = formData

    if (!exchange || !underlying_symbol || !trading_symbol || calculate_percentage === '' || !expiry_date) {
      setError('All fields are required')
      return false
    }

    const percentage = parseFloat(calculate_percentage)

    if (isNaN(percentage)) {
      setError('Calculate percentage must be a valid number')
      return false
    }

    return true
  }

  const calculateRange = (ltp) => {
    const percentage = parseFloat(formData.calculate_percentage)

    // Calculate maximum value (add percentage)
    const maxValue = (ltp * (1 + percentage / 100)).toFixed(2)

    // Calculate minimum value (subtract percentage)
    const minValue = (ltp * (1 - percentage / 100)).toFixed(2)

    return {
      max: parseFloat(maxValue),
      min: parseFloat(minValue),
    }
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setAnalysis(null)

    if (!validateForm()) {
      return
    }

    try {
      setLoading(true)

      const { exchange, underlying_symbol, trading_symbol, expiry_date, calculate_percentage } = formData

      // Call the analyze-option-chain endpoint which handles everything internally
      console.log(`Analyzing option chain for ${underlying_symbol}...`)

      const analyzeData = {
        symbol: underlying_symbol,
        underlying_symbol,
        trading_symbol,
        exchange,
        expiry_date,
        calculate_percentage: parseFloat(calculate_percentage),
      }

      const response = await fetch(`${import.meta.env.VITE_API_BASE_URL}/analyze-option-chain`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(analyzeData),
      })

      const data = await response.json()

      if (!response.ok) {
        setError(data.error || 'Failed to analyze option chain')
        return
      }

      if (data.status === 'SUCCESS') {
        // Calculate range for display
        const range = calculateRange(data.underlying_ltp)
        setCalculatedRange(range)
        setAnalysis(data)
        console.log('AI Analysis received:', data)
      } else {
        setError('Failed to get AI analysis')
      }
    } catch (err) {
      console.error('Error:', err)
      setError(err.message || 'An error occurred during analysis')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="ai-analysis-container">
      <div className="ai-analysis-form-section">
        <h2>Option Chain AI Analysis</h2>

        <form onSubmit={handleSubmit} className="ai-analysis-form">
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="exchange">Exchange</label>
              <select
                id="exchange"
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
              <label htmlFor="underlying_symbol">Underlying Symbol</label>
              <input
                id="underlying_symbol"
                type="text"
                name="underlying_symbol"
                value={formData.underlying_symbol}
                onChange={handleInputChange}
                placeholder="e.g., 360ONE"
                className="form-input"
              />
            </div>

            <div className="form-group">
              <label htmlFor="trading_symbol">Trading Symbol</label>
              <input
                id="trading_symbol"
                type="text"
                name="trading_symbol"
                value={formData.trading_symbol}
                onChange={handleInputChange}
                placeholder="e.g., 360ONE26FEB1200PE"
                className="form-input"
              />
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="calculate_percentage">Calculate Percentage (%)</label>
              <input
                id="calculate_percentage"
                type="number"
                name="calculate_percentage"
                value={formData.calculate_percentage}
                onChange={handleInputChange}
                placeholder="e.g., 5.5"
                step="0.1"
                className="form-input"
              />
            </div>

            <div className="form-group">
              <label htmlFor="expiry_date">Expiry Date</label>
              <input
                id="expiry_date"
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
            {loading ? 'Analyzing...' : 'Analyze Option Chain'}
          </button>
        </form>
      </div>

      {calculatedRange && (
        <div className="output-column">
          <div className="calculated-range-section">
            <h3>Calculated Range</h3>
            <div className="range-display">
              <div className="range-item">
                <span className="range-label">Minimum Value (LTP - %)</span>
                <span className="range-value min">₹{calculatedRange.min.toFixed(2)}</span>
              </div>
              <div className="range-item">
                <span className="range-label">Current LTP</span>
                <span className="range-value current">₹{analysis?.underlying_ltp?.toFixed(2) || 'N/A'}</span>
              </div>
              <div className="range-item">
                <span className="range-label">Maximum Value (LTP + %)</span>
                <span className="range-value max">₹{calculatedRange.max.toFixed(2)}</span>
              </div>
            </div>
          </div>

          {analysis && (
            <div className="analysis-result-section">
              <h3>AI Analysis Result</h3>

              <div className="analysis-metadata">
                <div className="metadata-item">
                  <span className="label">Symbol:</span>
                  <span className="value">{analysis.symbol}</span>
                </div>
                <div className="metadata-item">
                  <span className="label">Underlying LTP:</span>
                  <span className="value">₹{analysis.underlying_ltp}</span>
                </div>
                <div className="metadata-item">
                  <span className="label">Expiry Date:</span>
                  <span className="value">{analysis.expiry_date}</span>
                </div>
                <div className="metadata-item">
                  <span className="label">Exchange:</span>
                  <span className="value">{analysis.exchange}</span>
                </div>
              </div>

              {analysis.raw_text && (
                <div className="analysis-explanation">
                  <h4>Analysis Summary</h4>
                  <p>{analysis.raw_text}</p>
                </div>
              )}

              {analysis.parsed_analysis && (
                <div className="analysis-details">
                  <h4>Detailed Analysis</h4>
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
          )}
        </div>
      )}
    </div>
  )
}

export default AIAnalysis
