import { useEffect, useState } from 'react'

/**
 * Dark "terminal" app shell (sidebar + top header) from the Stitch mockup.
 * Greek Analysis, Compare, and Watchlist are the real, functional nav items -
 * everything else (AI Analysis is hidden here rather than removed - the
 * component/route still exists, just not linked from the nav; header
 * notifications, avatar) is decorative or unlinked.
 */
function ServerTimeClock() {
  const [now, setNow] = useState(new Date())

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  const time = now.toLocaleTimeString('en-US', { hour12: false })

  return (
    <div className="text-right">
      <p className="text-[10px] font-medium uppercase text-on-surface-variant">Local Time</p>
      <p className="text-on-surface font-mono text-sm">{time}</p>
    </div>
  )
}

const NAV_ITEMS = [
  { key: 'greek-analysis', label: 'Greek Analysis', icon: 'analytics', functional: true },
  { key: 'compare', label: 'Compare', icon: 'compare_arrows', functional: true },
  { key: 'watchlist', label: 'Watchlist', icon: 'visibility', functional: true },
]

function AppShell({ activeTab, onTabChange, children }) {
  return (
    <div className="min-h-screen bg-background text-on-background">
      <aside className="fixed left-0 top-0 h-full w-[250px] bg-surface-container-low border-r border-outline-variant flex flex-col p-md gap-base z-50">
        <div className="mb-xl px-sm">
          <h1 className="text-lg font-bold text-primary">ALPHA TERMINAL</h1>
          <p className="text-[11px] font-medium text-on-surface-variant uppercase tracking-widest">Trading Desk</p>
        </div>

        <nav className="flex-1 flex flex-col gap-xs">
          {NAV_ITEMS.map((item) => {
            const isActive = item.functional && activeTab === item.key
            return (
              <div
                key={item.key}
                onClick={item.functional ? () => onTabChange(item.key) : undefined}
                className={`flex items-center gap-md px-md py-sm rounded-lg transition-colors duration-150 ${
                  item.functional ? 'cursor-pointer active:scale-95' : 'cursor-default opacity-50'
                } ${
                  isActive
                    ? 'bg-primary-container text-on-primary-container'
                    : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container-highest'
                }`}
                title={item.functional ? undefined : 'Not available yet'}
              >
                <span className="material-symbols-outlined">{item.icon}</span>
                <span className="text-sm font-medium">{item.label}</span>
              </div>
            )
          })}
        </nav>
      </aside>

      <header className="sticky top-0 right-0 z-40 w-[calc(100%-250px)] ml-[250px] bg-surface/60 backdrop-blur-md border-b border-outline-variant flex justify-end items-center h-12 px-xl">
        <div className="flex items-center gap-md">
          <span className="material-symbols-outlined text-on-surface-variant opacity-50 cursor-default" title="Not available yet">
            notifications
          </span>
          <div
            className="w-8 h-8 rounded-full bg-primary-container text-on-primary-container flex items-center justify-center text-xs font-bold"
            title="Account"
          >
            U
          </div>
        </div>
      </header>

      <main className="ml-[250px] p-xl flex flex-col gap-lg">{children}</main>
    </div>
  )
}

export { ServerTimeClock }
export default AppShell
