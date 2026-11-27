/** The messages of the chat widget, a waiting indicator while the model reads the files, and the intro. */

import { useEffect, useRef } from 'react'
import AnswerText from './AnswerText'
import Spinner from '../Spinner'

export default function ChatThread({ messages, busy, waitingFor, loadError, conversationFiles }) {
  const endRef = useRef(null)
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' })
  }, [messages, busy])

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-sm flex flex-col gap-md" aria-live="polite">
      {loadError && <div className="text-sm text-bearish">{loadError}</div>}
      {messages.length === 0 && !loadError && (
        <div className="text-sm text-on-surface-variant flex flex-col gap-xs">
          <p>Attach a PDF, Excel, CSV or JSON file with the paperclip and ask about it. Files are stored, so you can come back to them later.</p>
          <p>Mention a date (“compare with the 10 Nov report”) and the stored file with that report date is added for you.</p>
          <p>Click <span className="material-symbols-outlined text-[14px] align-middle" aria-hidden="true">add</span> for a standard question: an Option Chain question (live, or a saved past date and time) or a Report question (topic, NSE report and your file). It is copied into the box so you can edit it before sending. Follow-up questions use the same option chain data; pick an Option Chain question again to refresh it.</p>
        </div>
      )}
      {messages.map((m, i) =>
        m.role === 'user' ? (
          <div key={i} className="self-end max-w-[88%] flex flex-col items-end gap-[2px]">
            {m.files?.length > 0 && <div className="text-[11px] text-on-surface-variant flex items-center gap-xs"><span className="material-symbols-outlined text-[14px]" aria-hidden="true">attach_file</span>{m.files.join(', ')}</div>}
            <div className="rounded-lg bg-surface-container-highest px-md py-sm text-sm whitespace-pre-wrap break-words">{m.content}</div>
          </div>
        ) : (
          <div key={i} className="max-w-[95%] flex flex-col gap-xs">
            {m.error ? <div className="text-sm text-bearish">{m.error}</div> : <AnswerText text={m.content} />}
            {m.notes?.map((note) => <div key={note} className="text-[11px] text-on-surface-variant">{note}</div>)}
          </div>
        )
      )}
      {busy && (
        <div className="text-sm text-on-surface-variant flex items-center gap-xs"><Spinner />{waitingFor}</div>
      )}
      {conversationFiles.length > 0 && !busy && (
        <div className="text-[11px] text-on-surface-variant border-t border-outline-variant pt-xs" title={conversationFiles.map((f) => `${f.title}${f.reportDate ? ` (${f.reportDate})` : ''}`).join('\n')}>
          Files in this chat: {conversationFiles.map((f) => f.title).join(', ')}
        </div>
      )}
      <div ref={endRef} />
    </div>
  )
}
