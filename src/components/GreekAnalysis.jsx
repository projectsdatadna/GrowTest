import { useEffect, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import Select from 'react-select'
import { getUnderlyingSymbols, addWatchlistEntry, getWatchlistEntries, removeWatchlistEntry, saveGrowwAccessToken } from '../services/api'
import { setFormData, setGrowToken, resetAll } from '../store/greekAnalysisSlice'
import { setWatchlistEntries } from '../store/watchlistSlice'

const underlyingSymbolSelectClassNames = {
  control: () =>
    'bg-surface-container-low border border-terminal-border rounded-lg text-sm px-xs min-w-[180px] text-on-surface',
  placeholder: () => 'text-on-surface-variant',
  input: () => 'text-on-surface',
  singleValue: () => 'text-on-surface',
  menu: () => 'bg-surface-container-low border border-terminal-border rounded-lg mt-xs overflow-hidden',
  menuPortal: () => 'z-[9999]',
  menuList: () => 'py-xs',
  option: ({ isFocused, isSelected }) =>
    `px-md py-sm text-sm cursor-pointer ${
      isSelected ? 'bg-primary-container text-on-primary-container' : isFocused ? 'bg-surface-container-highest text-on-surface' : 'text-on-surface'
    }`,
  noOptionsMessage: () => 'text-on-surface-variant text-sm px-md py-sm',
  indicatorSeparator: () => 'bg-terminal-border',
  dropdownIndicator: () => 'text-on-surface-variant',
  clearIndicator: () => 'text-on-surface-variant',
}

function ServerClock() {
  const [now, setNow] = useState(new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])
  return (
    <div className="text-right">
      <p className="text-[10px] uppercase text-on-surface-variant">Server Time</p>
      <p className="text-on-surface font-mono">{now.toLocaleTimeString('en-US', { hour12: false })}</p>
    </div>
  )
}

function GreekAnalysis() {
  const dispatch = useDispatch()
  const formData = useSelector((state) => state.greekAnalysis.formData)
  const growToken = useSelector((state) => state.greekAnalysis.growToken)
  const analysis = useSelector((state) => state.greekAnalysis.analysis)
  const watchlistEntries = useSelector((state) => state.watchlist.entries)

  const [underlyingSymbolOptions, setUnderlyingSymbolOptions] = useState([])

  const [addingToWatchlist, setAddingToWatchlist] = useState(false)
  const [watchlistMessage, setWatchlistMessage] = useState('')

  const [savingGrowToken, setSavingGrowToken] = useState(false)
  const [growTokenMessage, setGrowTokenMessage] = useState('')

  const refreshWatchlistEntries = () => {
    getWatchlistEntries()
      .then(({ entries }) => dispatch(setWatchlistEntries(entries || [])))
      .catch((err) => console.error('Failed to load watchlist entries:', err))
  }

  useEffect(() => {
    refreshWatchlistEntries()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    getUnderlyingSymbols()
      .then(({ symbols }) => setUnderlyingSymbolOptions((symbols || []).map((symbol) => ({ value: symbol, label: symbol }))))
      .catch((err) => console.error('Failed to load underlying symbols:', err))
  }, [])

  const handleAddToWatchlist = async () => {
    setWatchlistMessage('')
    const { exchange, underlying_symbol, expiry_date, points_range } = formData
    if (!exchange || !underlying_symbol || !expiry_date || !points_range) {
      setWatchlistMessage('Fill in Exchange, Underlying Symbol, Points Range and Expiry Date before adding to the watchlist.')
      return
    }
    setAddingToWatchlist(true)
    try {
      await addWatchlistEntry({ underlying_symbol, exchange, expiry_date, points_range: parseFloat(points_range) })
      setWatchlistMessage(`${underlying_symbol} added to the watchlist.`)
      refreshWatchlistEntries()
    } catch (err) {
      setWatchlistMessage(err.response?.data?.error || err.message || 'Failed to add to watchlist')
    } finally {
      setAddingToWatchlist(false)
    }
  }

  const handleRemoveWatchlistEntry = async (id) => {
    try {
      await removeWatchlistEntry(id)
      refreshWatchlistEntries()
    } catch (err) {
      setWatchlistMessage(err.response?.data?.error || err.message || 'Failed to remove watchlist entry')
    }
  }

  const handleInputChange = (e) => {
    const { name, value } = e.target
    dispatch(setFormData({ [name]: value }))
  }

  // Persists the Groww access token server-side - every Groww-dependent
  // route (including the unattended Watchlist scheduler) reads this same
  // stored value, so this is the only place a token needs to be supplied.
  const handleSaveGrowToken = async () => {
    if (!growToken) {
      setGrowTokenMessage('Enter a Groww access token before saving.')
      return
    }
    setSavingGrowToken(true)
    setGrowTokenMessage('')
    try {
      await saveGrowwAccessToken(growToken)
      setGrowTokenMessage('Saved - this token will be used for every Groww API call, including the Watchlist scheduler.')
    } catch (err) {
      setGrowTokenMessage(err.response?.data?.error || err.message || 'Failed to save Groww access token')
    } finally {
      setSavingGrowToken(false)
    }
  }

  // Wipes the form back to defaults and drops any persisted analysis from an
  // earlier version of this page.
  const handleClear = () => {
    dispatch(resetAll())
  }

  return (
    <div className="flex flex-col gap-lg">
      <section className="flex justify-between items-end flex-wrap gap-md">
        <div className="flex flex-col gap-xs">
          <h2 className="text-2xl font-bold text-white">Greek Analysis</h2>
          <p className="text-on-surface-variant text-sm">Configure a symbol and add it to the Watchlist for automatic tracking.</p>
        </div>
        <div className="flex items-center gap-md">
          <ServerClock />
          <button
            type="button"
            disabled={addingToWatchlist || !formData.underlying_symbol || !formData.exchange || !formData.expiry_date || !formData.points_range}
            onClick={handleAddToWatchlist}
            title="Track this symbol on the Watchlist tab - fetched and analyzed automatically every 5 minutes"
            className="flex items-center gap-sm px-md py-base border border-terminal-border rounded-lg hover:bg-surface-container-highest transition-all text-sm disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <span className="material-symbols-outlined">visibility</span>
            {addingToWatchlist ? 'Adding...' : 'Add to Watchlist'}
          </button>
          <button
            type="button"
            disabled={!analysis && !formData.underlying_symbol}
            onClick={handleClear}
            title="Clear the form and every stored analysis snapshot"
            className="flex items-center gap-sm px-md py-base border border-bearish/40 text-bearish rounded-lg hover:bg-bearish/10 transition-all text-sm disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <span className="material-symbols-outlined">delete</span>
            Clear
          </button>
        </div>
      </section>

      <div className="glass-panel p-md rounded-xl flex items-end gap-lg flex-wrap">
        <div className="flex flex-col gap-xs">
          <label className="text-[11px] uppercase text-on-surface-variant" htmlFor="ga-exchange">
            Exchange
          </label>
          <select
            id="ga-exchange"
            name="exchange"
            value={formData.exchange}
            onChange={handleInputChange}
            className="bg-surface-container-low border border-terminal-border rounded-lg text-sm px-md py-base min-w-[120px] text-on-surface"
          >
            <option value="NSE">NSE</option>
            <option value="BSE">BSE</option>
          </select>
        </div>

        <div className="flex flex-col gap-xs">
          <label className="text-[11px] uppercase text-on-surface-variant" htmlFor="ga-underlying_symbol">
            Underlying Symbol
          </label>
          <Select
            inputId="ga-underlying_symbol"
            unstyled
            isClearable
            options={underlyingSymbolOptions}
            value={formData.underlying_symbol ? { value: formData.underlying_symbol, label: formData.underlying_symbol } : null}
            onChange={(selected) => dispatch(setFormData({ underlying_symbol: selected?.value || '' }))}
            placeholder="e.g., NIFTY"
            classNames={underlyingSymbolSelectClassNames}
            menuPortalTarget={document.body}
          />
        </div>

        <div className="flex flex-col gap-xs flex-1 min-w-[160px]">
          <label className="text-[11px] uppercase text-on-surface-variant flex justify-between" htmlFor="ga-points_range">
            Points Range (+/-) <span>{formData.points_range}</span>
          </label>
          <input
            id="ga-points_range"
            type="number"
            name="points_range"
            value={formData.points_range}
            onChange={handleInputChange}
            placeholder="e.g., 500"
            step="50"
            min="50"
            className="bg-surface-container-low border border-terminal-border rounded-lg text-sm px-md py-base text-on-surface"
          />
        </div>

        <div className="flex flex-col gap-xs">
          <label className="text-[11px] uppercase text-on-surface-variant" htmlFor="ga-expiry_date">
            Expiry Date
          </label>
          <input
            id="ga-expiry_date"
            type="date"
            name="expiry_date"
            value={formData.expiry_date}
            onChange={handleInputChange}
            className="bg-surface-container-low border border-terminal-border rounded-lg text-sm px-md py-base text-on-surface"
          />
        </div>

        <div className="flex flex-col gap-xs flex-1 min-w-[220px]">
          <label className="text-[11px] uppercase text-on-surface-variant" htmlFor="ga-groww_token">
            Groww Access Token
          </label>
          <div className="flex gap-xs">
            <input
              id="ga-groww_token"
              type="password"
              value={growToken}
              onChange={(e) => dispatch(setGrowToken(e.target.value))}
              placeholder="Paste your Groww access token"
              className="bg-surface-container-low border border-terminal-border rounded-lg text-sm px-md py-base text-on-surface flex-1"
            />
            <button
              type="button"
              disabled={savingGrowToken || !growToken}
              onClick={handleSaveGrowToken}
              title="Save this token server-side so every Groww API call, including the Watchlist scheduler, uses it"
              className="px-md py-base border border-terminal-border rounded-lg hover:bg-surface-container-highest transition-all text-sm disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {savingGrowToken ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </div>

      {growTokenMessage && <div className="text-sm px-base text-on-surface-variant">{growTokenMessage}</div>}
      {watchlistMessage && <div className="text-sm px-base text-on-surface-variant">{watchlistMessage}</div>}

      <section className="glass-panel p-md rounded-xl flex flex-col gap-sm">
        <h3 className="text-sm font-bold text-white uppercase tracking-wider">Watchlist</h3>
        {watchlistEntries.length === 0 ? (
          <p className="text-on-surface-variant text-sm">
            No symbols tracked yet. Fill in the form above and click "Add to Watchlist" to auto-analyze it every 5 minutes on the Watchlist tab.
          </p>
        ) : (
          <ul className="flex flex-col gap-xs">
            {watchlistEntries.map((entry) => (
              <li
                key={entry.id}
                className="flex items-center justify-between gap-md px-base py-sm bg-surface-container-low border border-terminal-border rounded-lg text-sm"
              >
                <span className="text-on-surface">
                  {entry.underlying_symbol} · {entry.exchange} · Expiry {entry.expiry_date} · ±{entry.points_range} pts
                </span>
                <button
                  type="button"
                  onClick={() => handleRemoveWatchlistEntry(entry.id)}
                  className="flex items-center gap-xs px-sm py-1 border border-bearish/40 text-bearish rounded hover:bg-bearish/10 transition-all text-xs"
                >
                  <span className="material-symbols-outlined text-sm">delete</span>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

export default GreekAnalysis
