import { useState, useEffect } from 'react'
import { getCurrentQuote, getOptionChain, getAIInference } from '../services/api'
import './Dashboard.css'

function Dashboard({ instrument, refreshInterval, onRefreshIntervalChange }) {
  const [currentQuote, setCurrentQuote] = useState(null)
  const [error, setError] = useState('')
  const [filteredOptions, setFilteredOptions] = useState([])
  const [lastUpdate, setLastUpdate] = useState(null)
  const [optionChainLoading, setOptionChainLoading] = useState(false)
  const [optionChainError, setOptionChainError] = useState('')
  const [quoteLoading, setQuoteLoading] = useState(false)
  const [quoteError, setQuoteError] = useState('')
  const [expiryDates, setExpiryDates] = useState([])
  const [selectedExpiry, setSelectedExpiry] = useState(null)
  const [showCalendar, setShowCalendar] = useState(false)

  // Fetch current quote when stock is selected
  useEffect(() => {
    if (instrument?.trading_symbol || instrument?.symbol) {
      fetchCurrentQuote()
      fetchExpiryDates()
    }
  }, [instrument?.trading_symbol, instrument?.symbol])

  // Fetch option chain when stock is selected or expiry date changes
  useEffect(() => {
    if ((instrument?.trading_symbol || instrument?.symbol) && selectedExpiry) {
      fetchOptionChainData()
    }
  }, [instrument?.trading_symbol, instrument?.symbol, selectedExpiry])

  const fetchCurrentQuote = async () => {
    try {
      setQuoteError('')
      const symbol = instrument.trading_symbol || instrument.symbol
      const exchange = instrument.exchange || 'NSE'
      
      console.log(`Fetching quote for ${symbol}`)
      
      const data = await getCurrentQuote(symbol, exchange)
      
      if (data.error) {
        setQuoteError(data.error)
        setCurrentQuote(null)
      } else {
        setCurrentQuote(data)
        console.log('Quote data:', data)
      }
      setLastUpdate(new Date())
    } catch (err) {
      setQuoteError('Failed to fetch current quote')
      setCurrentQuote(null)
      console.error(err)
    } finally {
      setQuoteLoading(false)
    }
  }

  const fetchExpiryDates = async () => {
    try {
      const symbol = instrument.trading_symbol || instrument.symbol
      const exchange = instrument.exchange || 'NSE'
      
      console.log(`Fetching expiry dates for ${symbol}`)
      
      // Generate next 5 Thursdays as expiry dates
      const dates = []
      const today = new Date()
      
      for (let i = 0; i < 5; i++) {
        const date = new Date(today)
        const daysUntilThursday = (3 - date.getDay() + 7) % 7 || 7
        date.setDate(date.getDate() + daysUntilThursday + (i * 7))
        dates.push(date.toISOString().split('T')[0])
      }
      
      setExpiryDates(dates)
      if (dates.length > 0 && !selectedExpiry) {
        setSelectedExpiry(dates[0])
      }
    } catch (err) {
      console.error('Error fetching expiry dates:', err)
    }
  }

  const fetchOptionChainData = async () => {
    try {
      setOptionChainLoading(true)
      setOptionChainError('')
      
      const underlying_symbol = instrument.underlying_symbol || instrument.trading_symbol || instrument.symbol
      const exchange = instrument.exchange || 'NSE'
      const expiry_date = selectedExpiry
      
      if (!expiry_date) {
        setOptionChainError('No expiry date selected')
        return
      }
      
      console.log(`Fetching option chain for ${underlying_symbol} on ${expiry_date} from ${exchange}`)
      console.log('Instrument data:', instrument)
      
      const options = await getOptionChain(underlying_symbol, exchange, expiry_date)

      console.log('Option chain response:', options)
      
      // Parse the response format: { underlying_ltp, strikes: { "23400": { "CE": {...}, "PE": {...} } } }
      let optionsArray = []
      
      if (options?.strikes && typeof options.strikes === 'object') {
        // New format with strikes object containing CE/PE data
        Object.entries(options.strikes).forEach(([strikePrice, strikeData]) => {
          // Process CE (Call) options
          if (strikeData.CE) {
            optionsArray.push({
              strike_price: strikePrice,
              option_type: 'CE',
              trading_symbol: strikeData.CE.trading_symbol,
              ltp: strikeData.CE.ltp,
              open_interest: strikeData.CE.open_interest,
              volume: strikeData.CE.volume,
              greeks: strikeData.CE.greeks || {},
              iv: strikeData.CE.greeks?.iv || 0,
            })
          }
          // Process PE (Put) options
          if (strikeData.PE) {
            optionsArray.push({
              strike_price: strikePrice,
              option_type: 'PE',
              trading_symbol: strikeData.PE.trading_symbol,
              ltp: strikeData.PE.ltp,
              open_interest: strikeData.PE.open_interest,
              volume: strikeData.PE.volume,
              greeks: strikeData.PE.greeks || {},
              iv: strikeData.PE.greeks?.iv || 0,
            })
          }
        })
      } else if (Array.isArray(options)) {
        optionsArray = options
      } else if (options?.payload?.strikes) {
        optionsArray = options.payload.strikes
      } else if (options?.options) {
        optionsArray = options.options
      } else if (options?.data) {
        optionsArray = options.data
      }
      
      console.log(`Parsed ${optionsArray.length} options`)
      setFilteredOptions(optionsArray.slice(0, 100)) // Show first 100 by default
    } catch (err) {
      console.error('Error fetching option chain:', err)
      setOptionChainError('Failed to fetch option chain data')
      setFilteredOptions([])
    } finally {
      setOptionChainLoading(false)
    }
  }

  return (
    <div className="dashboard">
      <div className="dashboard-header">
        <div className="instrument-info">
          <h2>{instrument.trading_symbol || instrument.symbol}</h2>
          <p className="instrument-name">{instrument.instrument_name || instrument.name || instrument.description}</p>
          <div className="instrument-details">
            {instrument.exchange && <span className="detail-badge">Exchange: {instrument.exchange}</span>}
            {instrument.underlying_symbol && <span className="detail-badge">Underlying: {instrument.underlying_symbol}</span>}
            {instrument.expiry_date && <span className="detail-badge">Expiry: {new Date(instrument.expiry_date).toLocaleDateString('en-IN')}</span>}
          </div>
        </div>
        {lastUpdate && (
          <div className="last-update">
            Last updated: {lastUpdate.toLocaleTimeString()}
          </div>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}
      {quoteError && <div className="error-banner">{quoteError}</div>}
      {optionChainError && (
        <div className="error-banner">
          <div>{optionChainError}</div>
          <div style={{ fontSize: '12px', marginTop: '8px', opacity: 0.9 }}>
            💡 Tip: Groww API tokens expire daily at 6:00 AM IST. Please provide a fresh token.
          </div>
        </div>
      )}

      {/* Current Quote Section */}
      {quoteLoading ? (
        <div className="loading-container">
          <div className="loading-text">Fetching current quote...</div>
        </div>
      ) : currentQuote ? (
        <div className="card full-width">
          <h3>Current Quote - {instrument.trading_symbol || instrument.symbol}</h3>
          <div className="quote-display">
            <div className="quote-main">
              <div className="price">
                ₹{currentQuote.price || currentQuote.ltp || 'N/A'}
              </div>
              <div className="quote-meta">
                <div className="meta-item">
                  <span>High:</span>
                  <strong>₹{currentQuote.high || 'N/A'}</strong>
                </div>
                <div className="meta-item">
                  <span>Low:</span>
                  <strong>₹{currentQuote.low || 'N/A'}</strong>
                </div>
                <div className="meta-item">
                  <span>Volume:</span>
                  <strong>{currentQuote.volume || 0}</strong>
                </div>
                <div className="meta-item">
                  <span>Day Change:</span>
                  <strong>{currentQuote.day_change || 0}</strong>
                </div>
                <div className="meta-item">
                  <span>Day Change %:</span>
                  <strong>{currentQuote.day_change_perc || 0}%</strong>
                </div>
              </div>
            </div>
            <button onClick={fetchCurrentQuote} className="refresh-btn">
              🔄 Refresh Quote
            </button>
          </div>
          {lastUpdate && (
            <div className="last-update-text">
              Last updated: {lastUpdate.toLocaleTimeString()}
            </div>
          )}
        </div>
      ) : (
        <div className="no-data-container">
          <div className="no-data-text">No quote data available</div>
        </div>
      )}

      {/* Option Chain Data */}
      {optionChainLoading ? (
        <div className="loading-container">
          <div className="loading-text">Fetching option chain data...</div>
        </div>
      ) : filteredOptions.length > 0 ? (
        <div className="card full-width">
          <div className="option-chain-header">
            <h3>Option Chain Data ({filteredOptions.length} options)</h3>
            {expiryDates.length > 0 && (
              <div className="expiry-selector">
                <label htmlFor="expiry-input">Expiry Date:</label>
                <div className="expiry-input-wrapper">
                  <input
                    id="expiry-input"
                    type="text"
                    value={selectedExpiry ? new Date(selectedExpiry).toLocaleDateString('en-IN') : ''}
                    readOnly
                    placeholder="Select expiry date"
                    className="expiry-input"
                    onClick={() => setShowCalendar(!showCalendar)}
                  />
                  <button
                    className="calendar-btn"
                    onClick={() => setShowCalendar(!showCalendar)}
                    title="Open calendar"
                  >
                    📅
                  </button>
                  {showCalendar && (
                    <CalendarPicker
                      expiryDates={expiryDates}
                      selectedDate={selectedExpiry}
                      onSelectDate={(date) => {
                        setSelectedExpiry(date)
                        setShowCalendar(false)
                      }}
                    />
                  )}
                </div>
              </div>
            )}
          </div>
          <div className="options-table">
            <table>
              <thead>
                <tr>
                  <th>Trading Symbol</th>
                  <th>Strike Price</th>
                  <th>Type</th>
                  <th>LTP</th>
                  <th>OI</th>
                  <th>Volume</th>
                  <th>Delta</th>
                  <th>Gamma</th>
                  <th>Theta</th>
                  <th>Vega</th>
                  <th>Rho</th>
                  <th>IV</th>
                </tr>
              </thead>
              <tbody>
                {filteredOptions.slice(0, 100).map((option, idx) => (
                  <tr key={idx}>
                    <td className="symbol">{option.trading_symbol || option.symbol || 'N/A'}</td>
                    <td className="strike">₹{option.strike_price || option.strikePrice || 'N/A'}</td>
                    <td className={`type ${option.option_type === 'CE' ? 'ce' : 'pe'}`}>
                      {option.option_type || option.type || 'N/A'}
                    </td>
                    <td className="ltp">₹{option.ltp || option.price || 'N/A'}</td>
                    <td className="oi">{option.open_interest || option.openInterest || 0}</td>
                    <td className="volume">{option.volume || 0}</td>
                    <td className="greek">{option.greeks?.delta?.toFixed(4) || 'N/A'}</td>
                    <td className="greek">{option.greeks?.gamma?.toFixed(4) || 'N/A'}</td>
                    <td className="greek">{option.greeks?.theta?.toFixed(4) || 'N/A'}</td>
                    <td className="greek">{option.greeks?.vega?.toFixed(4) || 'N/A'}</td>
                    <td className="greek">{option.greeks?.rho?.toFixed(4) || 'N/A'}</td>
                    <td className="iv">{option.greeks?.iv ? (option.greeks.iv).toFixed(2) : option.iv ? (option.iv * 100).toFixed(2) : 'N/A'}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : !optionChainLoading && instrument?.trading_symbol ? (
        <div className="no-data-container">
          <div className="no-data-text">No option chain data available for {instrument.trading_symbol}</div>
        </div>
      ) : (
        <div className="no-data-container">
          <div className="no-data-text">Select a stock to view option chain data</div>
        </div>
      )}
    </div>
  )
}

// Calendar Picker Component
function CalendarPicker({ expiryDates, selectedDate, onSelectDate }) {
  const [currentMonth, setCurrentMonth] = useState(new Date())

  const getDaysInMonth = (date) => {
    return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
  }

  const getFirstDayOfMonth = (date) => {
    return new Date(date.getFullYear(), date.getMonth(), 1).getDay()
  }

  const handlePrevMonth = () => {
    setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1))
  }

  const handleNextMonth = () => {
    setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1))
  }

  const isExpiryDate = (day) => {
    const dateStr = `${currentMonth.getFullYear()}-${String(currentMonth.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    return expiryDates.includes(dateStr)
  }

  const isSelected = (day) => {
    if (!selectedDate) return false
    const dateStr = `${currentMonth.getFullYear()}-${String(currentMonth.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    return dateStr === selectedDate
  }

  const handleDateClick = (day) => {
    const dateStr = `${currentMonth.getFullYear()}-${String(currentMonth.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    if (isExpiryDate(day)) {
      onSelectDate(dateStr)
    }
  }

  const daysInMonth = getDaysInMonth(currentMonth)
  const firstDay = getFirstDayOfMonth(currentMonth)
  const days = []

  for (let i = 0; i < firstDay; i++) {
    days.push(null)
  }

  for (let i = 1; i <= daysInMonth; i++) {
    days.push(i)
  }

  const monthName = currentMonth.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })

  return (
    <div className="calendar-picker">
      <div className="calendar-header">
        <button onClick={handlePrevMonth} className="calendar-nav-btn">←</button>
        <span className="calendar-month">{monthName}</span>
        <button onClick={handleNextMonth} className="calendar-nav-btn">→</button>
      </div>
      <div className="calendar-weekdays">
        <div className="weekday">Sun</div>
        <div className="weekday">Mon</div>
        <div className="weekday">Tue</div>
        <div className="weekday">Wed</div>
        <div className="weekday">Thu</div>
        <div className="weekday">Fri</div>
        <div className="weekday">Sat</div>
      </div>
      <div className="calendar-days">
        {days.map((day, idx) => (
          <div
            key={idx}
            className={`calendar-day ${day ? 'active' : 'empty'} ${isExpiryDate(day) ? 'expiry' : ''} ${isSelected(day) ? 'selected' : ''}`}
            onClick={() => handleDateClick(day)}
          >
            {day}
          </div>
        ))}
      </div>
    </div>
  )
}

export default Dashboard
