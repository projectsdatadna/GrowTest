import { useState, useEffect, useRef } from 'react'
import './InstrumentList.css'

function InstrumentList({ onSelectInstrument, selectedInstrument }) {
  const [searchTerm, setSearchTerm] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [hasSearched, setHasSearched] = useState(false)
  const debounceTimerRef = useRef(null)

  // Debounced search function
  const performSearch = async (term) => {
    if (term.trim().length === 0) {
      setSearchResults([])
      setHasSearched(false)
      return
    }

    setLoading(true)
    setHasSearched(true)

    try {
      // Search for symbols using Groww API
      const response = await fetch(
        `http://localhost:5000/search?q=${encodeURIComponent(term)}`,
        {
          headers: {
            'Authorization': `Bearer ${localStorage.getItem('accessToken')}`
          }
        }
      )

      if (!response.ok) {
        throw new Error('Search failed')
      }

      const data = await response.json()
      setSearchResults(Array.isArray(data) ? data : data.results || [])
    } catch (err) {
      setError('Failed to search symbols')
      console.error(err)
      setSearchResults([])
    } finally {
      setLoading(false)
    }
  }

  const handleSearch = (e) => {
    const term = e.target.value
    setSearchTerm(term)
    setError('')

    // Clear previous timer
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
    }

    // Set new timer for debounced search (500ms delay)
    debounceTimerRef.current = setTimeout(() => {
      performSearch(term)
    }, 500)
  }

  // Cleanup timer on component unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }
    }
  }, [])

  return (
    <div className="instrument-list">
      <div className="list-header">
        <h3>Search Symbols</h3>
      </div>

      <input
        type="text"
        placeholder="Search by symbol or name (e.g., INFY, TCS)..."
        value={searchTerm}
        onChange={handleSearch}
        className="search-input"
      />

      {loading && <div className="loading">Searching...</div>}
      {error && <div className="error">{error}</div>}

      {selectedInstrument && (
        <div className="selected-instrument">
          <div className="selected-label">Selected:</div>
          <div className="selected-item">
            <div className="instrument-symbol">
              {selectedInstrument.trading_symbol || selectedInstrument.symbol}
            </div>
            <div className="instrument-name">
              {selectedInstrument.instrument_name || selectedInstrument.name || selectedInstrument.description}
            </div>
            <div className="instrument-exchange">
              {selectedInstrument.exchange}
            </div>
          </div>
        </div>
      )}

      {hasSearched && searchResults.length > 0 && (
        <div className="search-results">
          <div className="results-label">Results ({searchResults.length} found)</div>
          <div className="instruments">
            {searchResults.map((instrument, idx) => {
              const symbol = instrument.trading_symbol || instrument.symbol
              const name = instrument.instrument_name || instrument.name || instrument.description || ''
              const isSelected = selectedInstrument?.trading_symbol === symbol || selectedInstrument?.symbol === symbol
              
              return (
                <div
                  key={idx}
                  className={`instrument-item ${isSelected ? 'active' : ''}`}
                  onClick={() => {
                    onSelectInstrument({
                      symbol: symbol,
                      trading_symbol: symbol,
                      name: name,
                      instrument_name: name,
                      exchange: instrument.exchange,
                      segment: instrument.segment,
                      underlying_symbol: instrument.underlying_symbol || symbol,
                      expiry_date: instrument.expiry_date || '',
                    })
                    setSearchTerm('')
                    setSearchResults([])
                    setHasSearched(false)
                  }}
                >
                  <div className="instrument-symbol">{symbol}</div>
                  <div className="instrument-name">{name || '(No name)'}</div>
                  <div className="instrument-exchange">{instrument.exchange}</div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {hasSearched && searchResults.length === 0 && !loading && (
        <div className="no-results">No symbols found. Try searching with a different term.</div>
      )}

      {!hasSearched && searchResults.length === 0 && !selectedInstrument && (
        <div className="no-results">Start typing to search for symbols</div>
      )}
    </div>
  )
}

export default InstrumentList
