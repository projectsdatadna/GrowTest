/**
 * FII Reports: upload and keep the reports (PDF / Excel / CSV) with their dates, compare the current
 * report with any earlier date, and ask questions about them.
 */

import { useState } from 'react'
import DocumentUpload from './DocumentUpload'
import DocumentLibrary from './DocumentLibrary'
import ComparePanel from './ComparePanel'
import ChatPanel from '../assistant/ChatPanel'

const VIEWS = [
  { key: 'library', label: 'Reports' },
  { key: 'compare', label: 'Compare' },
  { key: 'ask', label: 'Ask' },
]
const FII_SCOPE = { docType: 'fii_report' }

export default function FiiReportsTab() {
  const [view, setView] = useState('library')
  const [refreshKey, setRefreshKey] = useState(0)
  const bump = () => setRefreshKey((k) => k + 1)

  return (
    <div className="flex flex-col gap-md">
      <div>
        <h2 className="text-lg font-semibold text-on-surface">FII Reports</h2>
        <p className="text-xs text-on-surface-variant">Upload FII/DII reports, compare the current one with any earlier date, and ask questions about them.</p>
      </div>

      <div className="flex gap-xs" role="tablist" aria-label="FII reports views">
        {VIEWS.map((v) => (
          <button
            key={v.key}
            type="button"
            role="tab"
            aria-selected={view === v.key}
            onClick={() => setView(v.key)}
            className={`px-md py-xs rounded-full text-sm border ${view === v.key ? 'bg-primary-container text-on-primary-container border-transparent' : 'border-outline-variant text-on-surface-variant hover:text-on-surface'}`}
          >
            {v.label}
          </button>
        ))}
      </div>

      {view === 'library' && (
        <div className="flex flex-col gap-lg">
          <section className="glass-panel rounded-xl p-md flex flex-col gap-sm" aria-label="Upload">
            <h3 className="text-sm font-semibold text-on-surface">Upload reports</h3>
            <DocumentUpload defaultDocType="fii_report" onUploaded={bump} />
          </section>
          <section className="glass-panel rounded-xl p-md flex flex-col gap-sm" aria-label="Library">
            <h3 className="text-sm font-semibold text-on-surface">Library</h3>
            <DocumentLibrary docType="fii_report" refreshKey={refreshKey} onChanged={bump} />
          </section>
        </div>
      )}
      {view === 'compare' && (
        <section className="glass-panel rounded-xl p-md" aria-label="Compare reports">
          <ComparePanel refreshKey={refreshKey} />
        </section>
      )}
      {view === 'ask' && (
        <section className="glass-panel rounded-xl p-md min-h-[55vh] flex flex-col" aria-label="Ask about FII reports">
          <ChatPanel
            className="flex-1"
            scope={FII_SCOPE}
            placeholder="Ask about the FII reports, e.g. “What did FIIs do in index futures on 14 Nov?”"
            suggestions={['What was FII activity in the latest report?', 'How did FII index futures positioning change last week?']}
          />
        </section>
      )}
    </div>
  )
}
