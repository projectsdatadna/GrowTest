/**
 * Hover chart for Notifications cards. One chart at a time: hovering a card's
 * chart button opens it (after a short intent delay) in a popover next to the
 * button; moving to another card's button switches to that card at once;
 * leaving the button and the popover closes it (small grace so the pointer can
 * travel from the button into the popover); Esc and scrolling close it too.
 * Tap/click on the button toggles it (touch screens have no hover).
 */

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

const CrossoverCardChart = lazy(() => import('./CrossoverCardChart'))

const OPEN_DELAY_MS = 150
const CLOSE_DELAY_MS = 200
const POPOVER_WIDTH = 680
const POPOVER_MAX_HEIGHT_RATIO = 0.8
const MARGIN = 8

// Popover position: to the right of the button, or the left when there is no room; clamped to the viewport.
function placement(rect) {
  const width = Math.min(POPOVER_WIDTH, window.innerWidth - 2 * MARGIN)
  const roomRight = window.innerWidth - rect.right - MARGIN
  let left = roomRight >= width ? rect.right + MARGIN : rect.left - width - MARGIN
  left = Math.max(MARGIN, Math.min(left, window.innerWidth - width - MARGIN))
  const maxHeight = Math.floor(window.innerHeight * POPOVER_MAX_HEIGHT_RATIO)
  const center = rect.top + rect.height / 2
  const top = Math.max(MARGIN, Math.min(center - maxHeight / 2, window.innerHeight - maxHeight - MARGIN))
  return { left, top, width, maxHeight }
}

export function useCardChartHover() {
  const [active, setActive] = useState(null) // {group, rect}
  const popoverRef = useRef(null)
  const openTimer = useRef(null)
  const closeTimer = useRef(null)
  const activeRef = useRef(null)
  activeRef.current = active

  const clearTimers = () => {
    clearTimeout(openTimer.current)
    clearTimeout(closeTimer.current)
  }
  const close = useCallback(() => {
    clearTimeout(openTimer.current)
    clearTimeout(closeTimer.current)
    setActive(null)
  }, [])
  const scheduleClose = useCallback(() => {
    clearTimeout(openTimer.current)
    clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => setActive(null), CLOSE_DELAY_MS)
  }, [])

  // Another card's button: swap immediately; the same card: just keep it open.
  const onEnter = useCallback((group, element) => {
    clearTimers()
    const open = () => setActive({ group, rect: element.getBoundingClientRect() })
    if (activeRef.current?.group.id === group.id) return
    if (activeRef.current) open()
    else openTimer.current = setTimeout(open, OPEN_DELAY_MS)
  }, [])
  const onToggle = useCallback((group, element) => {
    clearTimers()
    if (activeRef.current?.group.id === group.id) setActive(null)
    else setActive({ group, rect: element.getBoundingClientRect() })
  }, [])
  const keepOpen = useCallback(() => clearTimeout(closeTimer.current), [])

  useEffect(() => {
    if (!active) return undefined
    const onKey = (event) => event.key === 'Escape' && close()
    window.addEventListener('keydown', onKey)
    // Page scrolling closes the chart; the popover's own scrolling (it is taller
    // than the viewport when several indicators crossed) must not.
    const onScroll = (event) => {
      if (popoverRef.current?.contains(event.target)) return
      close()
    }
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [active, close])
  useEffect(() => clearTimers, [])

  const popover = active
    ? createPortal(
        <div
          ref={popoverRef}
          role="dialog"
          aria-label={`${active.group.symbol} chart`}
          onMouseEnter={keepOpen}
          onMouseLeave={scheduleClose}
          style={{ position: 'fixed', zIndex: 60, overflowY: 'auto', overscrollBehavior: 'contain', scrollbarWidth: 'thin', ...placement(active.rect) }}
          className="rounded-xl border border-outline-variant bg-surface-container shadow-2xl p-sm"
        >
          <Suspense fallback={<div className="text-xs text-on-surface-variant py-md">Loading chart…</div>}>
            <CrossoverCardChart key={active.group.id} group={active.group} />
          </Suspense>
        </div>,
        document.body
      )
    : null

  return { onEnter, onLeave: scheduleClose, onToggle, popover, activeId: active?.group.id ?? null }
}

export function CardChartButton({ group, hover }) {
  const open = hover.activeId === group.id
  return (
    <button
      type="button"
      onMouseEnter={(e) => hover.onEnter(group, e.currentTarget)}
      onMouseLeave={hover.onLeave}
      onFocus={(e) => hover.onEnter(group, e.currentTarget)}
      onBlur={hover.onLeave}
      onClick={(e) => {
        e.stopPropagation() // do not mark the card read
        hover.onToggle(group, e.currentTarget)
      }}
      title="Hover to see this crossover on a chart"
      aria-label={`Show chart for ${group.symbol} ${group.interval}`}
      aria-expanded={open}
      className={`self-center flex items-center gap-xs px-sm py-xs rounded-lg border text-xs ${open ? 'border-primary text-primary' : 'border-outline-variant text-on-surface-variant'} hover:text-primary`}
    >
      <span className="material-symbols-outlined text-[18px]">show_chart</span>
      Chart
    </button>
  )
}
