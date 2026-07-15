import { useEffect, useState } from 'react'

/**
 * Dark "terminal" app shell (sidebar + top header) from the Stitch mockup.
 * Only "AI Analysis" and "Greek Analysis" are real, functional nav items -
 * everything else (Dashboard-as-a-separate-page, Volatility, Strategy
 * Builder, Portfolio, Settings, Support, the search bar, Watchlist/Alerts,
 * notifications, avatar) is decorative - those pages don't exist yet.
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
  { key: 'ai-analysis', label: 'AI Analysis', icon: 'dashboard', functional: true },
  { key: 'greek-analysis', label: 'Greek Analysis', icon: 'analytics', functional: true },
  { key: 'volatility', label: 'Volatility', icon: 'show_chart', functional: false },
  { key: 'strategy-builder', label: 'Strategy Builder', icon: 'construction', functional: false },
  { key: 'portfolio', label: 'Portfolio', icon: 'account_balance_wallet', functional: false },
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

        <div className="mt-auto flex flex-col gap-xs pt-md border-t border-outline-variant">
          <div className="flex items-center gap-md px-md py-sm text-on-surface-variant opacity-50 cursor-default rounded-lg" title="Not available yet">
            <span className="material-symbols-outlined">settings</span>
            <span className="text-sm font-medium">Settings</span>
          </div>
          <div className="flex items-center gap-md px-md py-sm text-on-surface-variant opacity-50 cursor-default rounded-lg" title="Not available yet">
            <span className="material-symbols-outlined">help</span>
            <span className="text-sm font-medium">Support</span>
          </div>
        </div>
      </aside>

      <header className="sticky top-0 right-0 z-40 w-[calc(100%-250px)] ml-[250px] bg-surface/60 backdrop-blur-md border-b border-outline-variant flex justify-between items-center h-12 px-xl">
        <div className="flex items-center gap-xl">
          <div className="flex items-center gap-sm bg-surface-container-high px-md py-1 rounded-full border border-outline-variant opacity-60" title="Not available yet">
            <span className="material-symbols-outlined text-on-surface-variant text-[18px]">search</span>
            <input
              className="bg-transparent border-none focus:ring-0 text-sm text-on-surface w-48 p-0 cursor-default"
              placeholder="Search Markets..."
              type="text"
              disabled
            />
          </div>
          <nav className="flex gap-lg">
            <span className="text-sm text-primary font-bold border-b-2 border-primary pb-1">Market Data</span>
            <span className="text-sm text-on-surface-variant opacity-50 cursor-default" title="Not available yet">
              Watchlist
            </span>
            <span className="text-sm text-on-surface-variant opacity-50 cursor-default" title="Not available yet">
              Alerts
            </span>
          </nav>
        </div>
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
