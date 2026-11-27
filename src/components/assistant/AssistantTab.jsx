/**
 * Assistant page: chat with your stored files. Attach a PDF / Excel / CSV / JSON file with the paperclip (or drop it on
 * the chat): it is stored in Firestore with its report date and kept. Mention a date in the question
 * ("compare with the 10 Nov report") and the stored file with that report date is added. "My files" on the
 * right lists everything stored. Answers appear when complete; a refresh restores the conversation.
 */

import { useRef, useState } from 'react'
import useFileChat from './useFileChat'
import ChatThread from './ChatThread'
import ChatComposer from './ChatComposer'
import FilesPanel from './FilesPanel'

export default function AssistantTab() {
  const chat = useFileChat()
  const [dragging, setDragging] = useState(false)
  const addFilesRef = useRef(null)

  return (
    <div className="flex flex-col gap-md h-[calc(100vh-9.5rem)] min-h-[520px]">
      <div className="flex items-center justify-between gap-md">
        <div>
          <h2 className="text-lg font-semibold text-on-surface">Assistant</h2>
          <p className="text-xs text-on-surface-variant">Ask questions about your PDF, Excel, CSV and JSON files. Files are stored with their report date, so you can come back to them.</p>
        </div>
        <button type="button" onClick={chat.newChat} disabled={chat.busy} className="px-md py-sm rounded-lg border border-outline-variant text-sm text-on-surface flex items-center gap-xs disabled:opacity-50">
          <span className="material-symbols-outlined text-[18px]">edit_square</span>
          New chat
        </button>
      </div>

      <div className="grid flex-1 min-h-0 gap-md lg:grid-cols-[minmax(0,1fr)_340px] max-lg:grid-rows-[minmax(0,1fr)_240px]">
        <section
          aria-label="Chat"
          onDragOver={(e) => {
            if (e.dataTransfer?.types?.includes('Files')) {
              e.preventDefault()
              setDragging(true)
            }
          }}
          onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget) && setDragging(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            addFilesRef.current?.(e.dataTransfer.files)
          }}
          className="glass-panel rounded-xl relative flex flex-col min-h-0 overflow-hidden"
        >
          <ChatThread messages={chat.messages} busy={chat.busy} waitingFor={chat.waitingFor} loadError={chat.loadError} conversationFiles={chat.conversationFiles} />
          <ChatComposer chips={chat.chips} setChips={chat.setChips} onSend={chat.send} busy={chat.busy} addFilesRef={addFilesRef} chatContext={chat.chatContext} setChatContext={chat.setChatContext} />
          {dragging && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/80 border-2 border-dashed border-primary text-on-surface text-sm pointer-events-none animate-fade-in">
              Drop PDF, Excel, CSV or JSON files to attach them
            </div>
          )}
        </section>

        <aside aria-label="My files" className="glass-panel rounded-xl flex flex-col min-h-0 overflow-hidden">
          <div className="px-md py-sm border-b border-outline-variant text-sm font-medium text-on-surface">My files</div>
          <FilesPanel refreshKey={`${chat.chips.filter((c) => c.status === 'ready').length}:${chat.conversationFiles.length}`} conversationFileIds={chat.conversationFiles.map((f) => f.id)} attachedIds={chat.chips.map((c) => c.id).filter(Boolean)} onAttach={chat.attachStored} />
        </aside>
      </div>
    </div>
  )
}
