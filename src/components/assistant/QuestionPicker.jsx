/**
 * The "+" button of the chat box. It opens a small menu with the two kinds of standard question, each with its
 * own popup:
 *   Option Chain question   OptionChainPicker - live or saved-snapshot option chain data, then the question
 *   Report question         ReportPicker      - topic, NSE report name, the file, then the question
 * A picked question is only copied into the text box (onPick), never sent.
 */

import { useEffect, useRef, useState } from 'react'
import OptionChainPicker from './OptionChainPicker'
import ReportPicker from './ReportPicker'

/** current = the context already on the chat ({ optionChain, wordLimit }); attachedCount = files already waiting for the next question; onPick(text, context, files). */
export default function QuestionPicker({ current, onPick, disabled, attachedCount = 0 }) {
  const [menu, setMenu] = useState(false)
  const [popup, setPopup] = useState(null) // 'optionChain' | 'report'
  const wrapRef = useRef(null)

  useEffect(() => {
    if (!menu) return undefined
    const onDown = (e) => !wrapRef.current?.contains(e.target) && setMenu(false)
    const onKey = (e) => e.key === 'Escape' && setMenu(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menu])

  const open = (kind) => {
    setMenu(false)
    setPopup(kind)
  }
  const close = () => setPopup(null)

  return (
    <div ref={wrapRef} className="relative">
      <button type="button" onClick={() => setMenu((m) => !m)} disabled={disabled} title="Pick a standard question" aria-label="Pick a standard question" aria-haspopup="menu" aria-expanded={menu} className="p-sm rounded-lg text-on-surface-variant hover:bg-surface-container-highest disabled:opacity-50">
        <span className="material-symbols-outlined">add</span>
      </button>
      {menu && (
        <div role="menu" className="absolute bottom-full left-0 mb-xs z-20 w-64 rounded-lg border border-outline-variant bg-surface shadow-lg p-xs flex flex-col">
          <button type="button" role="menuitem" onClick={() => open('optionChain')} className="text-left rounded-lg px-md py-sm hover:bg-surface-container-highest flex items-start gap-sm">
            <span className="material-symbols-outlined text-[20px] text-on-surface-variant" aria-hidden="true">candlestick_chart</span>
            <span><span className="block text-sm text-on-surface">Option Chain question</span><span className="block text-[11px] text-on-surface-variant">Live or a saved past date and time</span></span>
          </button>
          <button type="button" role="menuitem" onClick={() => open('report')} className="text-left rounded-lg px-md py-sm hover:bg-surface-container-highest flex items-start gap-sm">
            <span className="material-symbols-outlined text-[20px] text-on-surface-variant" aria-hidden="true">description</span>
            <span><span className="block text-sm text-on-surface">Report question</span><span className="block text-[11px] text-on-surface-variant">Topic, NSE report and your file</span></span>
          </button>
        </div>
      )}
      {popup === 'optionChain' && <OptionChainPicker current={current} onPick={onPick} onClose={close} />}
      {popup === 'report' && <ReportPicker onPick={onPick} onClose={close} attachedCount={attachedCount} />}
    </div>
  )
}
