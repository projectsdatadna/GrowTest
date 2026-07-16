import { useEffect, useState } from 'react'
import Select from 'react-select'
import {
  getUnderlyingSymbols,
  getOptionChainSnapshots,
  getOptionChainSnapshotById,
  compareOptionChainSnapshots,
} from '../services/api'
import AnalysisSnapshotCard from './AnalysisSnapshotCard'
import ComparisonPanel from './ComparisonPanel'
import OiBuildupPanel from './OiBuildupPanel'
import { computeOiChanges, computeGreeksDelta } from './greekAnalysisUtils'

const underlyingSymbolSelectClassNames = {
  control: () =>
    'bg-surface-container-low border border-terminal-border rounded-lg text-sm px-xs min-w-[180px] text-on-surface',
  placeholder: () => 'text-on-surface-variant',
  input: () => 'text-on-surface',
  singleValue: () => 'text-on-surface',
  menu: () => 'bg-surface-container-low border border-terminal-border rounded-lg mt-xs overflow-hidden z-20',
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

function formatSnapshotLabel(snapshot) {
  const when = snapshot.createdAt
    ? new Date(snapshot.createdAt).toLocaleString('en-US', { hour12: false })
    : 'Unknown time'
  return `${when} · Exp ${snapshot.expiry_date} · LTP ₹${snapshot.underlying_ltp}`
}

function CompareSnapshots() {
  const [underlyingSymbolOptions, setUnderlyingSymbolOptions] = useState([])
  const [selectedSymbol, setSelectedSymbol] = useState('')

  const [snapshots, setSnapshots] = useState([])
  const [loadingSnapshots, setLoadingSnapshots] = useState(false)
  const [snapshotsError, setSnapshotsError] = useState('')

  const [snapshotAId, setSnapshotAId] = useState('')
  const [snapshotBId, setSnapshotBId] = useState('')

  const [comparing, setComparing] = useState(false)
  const [compareError, setCompareError] = useState('')
  const [result, setResult] = useState(null)

  useEffect(() => {
    getUnderlyingSymbols()
      .then(({ symbols }) => setUnderlyingSymbolOptions((symbols || []).map((symbol) => ({ value: symbol, label: symbol }))))
      .catch((err) => console.error('Failed to load underlying symbols:', err))
  }, [])

  useEffect(() => {
    setSnapshotAId('')
    setSnapshotBId('')
    setResult(null)
    setCompareError('')

    if (!selectedSymbol) {
      setSnapshots([])
      return
    }

    setLoadingSnapshots(true)
    setSnapshotsError('')
    getOptionChainSnapshots(selectedSymbol)
      .then(({ snapshots: fetchedSnapshots }) => setSnapshots(fetchedSnapshots || []))
      .catch((err) => setSnapshotsError(err.response?.data?.error || err.message || 'Failed to load saved snapshots'))
      .finally(() => setLoadingSnapshots(false))
  }, [selectedSymbol])

  const handleAnalyze = async () => {
    setComparing(true)
    setCompareError('')
    try {
      const [{ snapshot: snapshotA }, { snapshot: snapshotB }] = await Promise.all([
        getOptionChainSnapshotById(snapshotAId),
        getOptionChainSnapshotById(snapshotBId),
      ])

      const [previous, latest] =
        new Date(snapshotA.createdAt) <= new Date(snapshotB.createdAt) ? [snapshotA, snapshotB] : [snapshotB, snapshotA]

      const comparison = await compareOptionChainSnapshots(previous, latest)
      const oiChanges = computeOiChanges(previous, latest)
      const greeksDelta = computeGreeksDelta(previous, latest)

      setResult({ previous, latest, comparison, oiChanges, greeksDelta })
    } catch (err) {
      setCompareError(err.response?.data?.error || err.message || 'Failed to compare snapshots')
    } finally {
      setComparing(false)
    }
  }

  const canAnalyze = snapshotAId && snapshotBId && snapshotAId !== snapshotBId && !comparing

  const snapshotAOptions = snapshots.filter((s) => s.id !== snapshotBId)
  const snapshotBOptions = snapshots.filter((s) => s.id !== snapshotAId)

  return (
    <div className="flex flex-col gap-lg">
      <section className="flex flex-col gap-xs">
        <h2 className="text-2xl font-bold text-white">Compare</h2>
        <p className="text-on-surface-variant text-sm">
          Pick an underlying symbol, choose any two saved analysis runs, and generate an AI trend inference between them.
        </p>
      </section>

      <div className="glass-panel p-md rounded-xl flex items-end gap-lg flex-wrap">
        <div className="flex flex-col gap-xs">
          <label className="text-[11px] uppercase text-on-surface-variant" htmlFor="cmp-underlying_symbol">
            Underlying Symbol
          </label>
          <Select
            inputId="cmp-underlying_symbol"
            unstyled
            isClearable
            options={underlyingSymbolOptions}
            value={selectedSymbol ? { value: selectedSymbol, label: selectedSymbol } : null}
            onChange={(selected) => setSelectedSymbol(selected?.value || '')}
            placeholder="e.g., NIFTY"
            classNames={underlyingSymbolSelectClassNames}
          />
        </div>

        <div className="flex flex-col gap-xs flex-1 min-w-[260px]">
          <label className="text-[11px] uppercase text-on-surface-variant" htmlFor="cmp-snapshot-a">
            Snapshot A
          </label>
          <select
            id="cmp-snapshot-a"
            value={snapshotAId}
            onChange={(e) => setSnapshotAId(e.target.value)}
            disabled={!selectedSymbol || loadingSnapshots}
            className="bg-surface-container-low border border-terminal-border rounded-lg text-sm px-md py-base text-on-surface disabled:opacity-50"
          >
            <option value="">Select a saved run...</option>
            {snapshotAOptions.map((s) => (
              <option key={s.id} value={s.id}>
                {formatSnapshotLabel(s)}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-xs flex-1 min-w-[260px]">
          <label className="text-[11px] uppercase text-on-surface-variant" htmlFor="cmp-snapshot-b">
            Snapshot B
          </label>
          <select
            id="cmp-snapshot-b"
            value={snapshotBId}
            onChange={(e) => setSnapshotBId(e.target.value)}
            disabled={!selectedSymbol || loadingSnapshots}
            className="bg-surface-container-low border border-terminal-border rounded-lg text-sm px-md py-base text-on-surface disabled:opacity-50"
          >
            <option value="">Select a saved run...</option>
            {snapshotBOptions.map((s) => (
              <option key={s.id} value={s.id}>
                {formatSnapshotLabel(s)}
              </option>
            ))}
          </select>
        </div>

        <button
          type="button"
          disabled={!canAnalyze}
          onClick={handleAnalyze}
          className="bg-primary-container text-on-primary-container text-sm px-xl py-lg rounded-lg shadow-lg shadow-primary-container/20 hover:scale-[1.02] active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {comparing ? 'Analyzing...' : 'Analyze'}
        </button>
      </div>

      {selectedSymbol && !loadingSnapshots && snapshots.length === 0 && !snapshotsError && (
        <div className="text-on-surface-variant text-sm px-base">
          No saved runs yet for {selectedSymbol} - run a Greek Analysis for it first.
        </div>
      )}
      {snapshotsError && <div className="text-bearish text-sm px-base">{snapshotsError}</div>}
      {compareError && <div className="text-bearish text-sm px-base">{compareError}</div>}

      {result && (
        <>
          <section className="grid grid-cols-1 md:grid-cols-3 gap-md items-start">
            <AnalysisSnapshotCard
              analysis={result.previous}
              label="Snapshot A (earlier)"
              variant="previous"
              timestamp={result.previous.createdAt ? new Date(result.previous.createdAt) : null}
            />
            <AnalysisSnapshotCard
              analysis={result.latest}
              label="Snapshot B (later)"
              variant="latest"
              timestamp={result.latest.createdAt ? new Date(result.latest.createdAt) : null}
            />
            <ComparisonPanel
              comparing={false}
              comparisonError=""
              comparison={result.comparison}
              greeksDelta={result.greeksDelta}
              title="Trend Inference"
            />
          </section>

          <section className="grid grid-cols-1 md:grid-cols-3 gap-md">
            <OiBuildupPanel
              title="Key Strike Changes"
              rows={result.oiChanges?.keyStrikeChanges || []}
              barColorClass="bg-primary"
              formatLabel={(r) => `${r.strike} ${r.type}`}
            />
            <OiBuildupPanel
              title="Top OI Buildup Calls"
              rows={result.oiChanges?.topCallBuildup || []}
              barColorClass="bg-bullish"
              formatLabel={(r) => `${r.strike} CE`}
            />
            <OiBuildupPanel
              title="Top OI Buildup Puts"
              rows={result.oiChanges?.topPutBuildup || []}
              barColorClass="bg-bearish"
              formatLabel={(r) => `${r.strike} PE`}
            />
          </section>
        </>
      )}
    </div>
  )
}

export default CompareSnapshots
