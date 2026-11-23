/**
 * The chat widget, fixed at the bottom-right of every page. Attach a PDF / Excel / CSV file with the
 * paperclip (or drop it on the window): it is stored in Firestore and kept with its report date. Each
 * question is sent with the conversation id and the file ids; the server loads those files and sends
 * them with the question to the model. A date in the question ("compare with 10 Nov") adds the stored
 * file with that report date. The conversation id is remembered, so a refresh restores the chat.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { sendChat, getConversation, errorText } from '../../services/api'
import ChatThread from './ChatThread'
import ChatComposer from './ChatComposer'
import FilesPanel from './FilesPanel'

const OPEN_KEY = 'growtest.chatbotOpen'
const CONVERSATION_KEY = 'growtest.chatConversationId'

const read = (key) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
const write = (key, value) => {
  try {
    if (value == null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // storage unavailable: the chat just does not survive a refresh
  }
}

export default function FloatingChatbot() {
  const [isOpen, setIsOpen] = useState(() => read(OPEN_KEY) === 'true')
  const [view, setView] = useState('chat') // 'chat' | 'files'
  const [conversationId, setConversationId] = useState(() => read(CONVERSATION_KEY))
  const [messages, setMessages] = useState([])
  const [conversationFiles, setConversationFiles] = useState([]) // files the conversation uses
  const [chips, setChips] = useState([]) // files waiting to be sent with the next message
  const [busy, setBusy] = useState(false)
  const [waitingFor, setWaitingFor] = useState('')
  const [loadError, setLoadError] = useState('')
  const [dragging, setDragging] = useState(false)
  const addFilesRef = useRef(null)
  const restored = useRef(false)

  const open = (value) => {
    setIsOpen(value)
    write(OPEN_KEY, String(value))
  }

  // Bring back the saved conversation the first time the window is opened.
  useEffect(() => {
    if (!isOpen || restored.current || !conversationId) return
    restored.current = true
    getConversation(conversationId)
      .then((saved) => {
        setMessages(saved.messages.map((m) => ({ role: m.role, content: m.content })))
        setConversationFiles(saved.files)
      })
      .catch((err) => {
        if (err?.response?.status === 404) {
          setConversationId(null)
          write(CONVERSATION_KEY, null)
        } else setLoadError(errorText(err))
      })
  }, [isOpen, conversationId])

  const newChat = () => {
    if (busy) return
    restored.current = true
    setConversationId(null)
    write(CONVERSATION_KEY, null)
    setMessages([])
    setConversationFiles([])
    setChips([])
    setLoadError('')
    setView('chat')
  }

  const send = useCallback(
    async (question, restoreText) => {
      const ready = chips.filter((c) => c.status === 'ready')
      setMessages((m) => [...m, { role: 'user', content: question, files: ready.map((c) => c.title) }])
      setWaitingFor(ready.length || conversationFiles.length ? 'Reading the files…' : 'Thinking…')
      setBusy(true)
      try {
        const result = await sendChat({ message: question, conversationId, fileIds: ready.map((c) => c.id) })
        setConversationId(result.conversationId)
        write(CONVERSATION_KEY, result.conversationId)
        const notes = [
          ...result.newlyAttached.filter((f) => f.auto).map((f) => `Added by date: ${f.title}${f.reportDate ? ` (${f.reportDate})` : ''}`),
          ...(result.dropped.length ? [`Left out because of the size limit: ${result.dropped.map((f) => f.title).join(', ')}`] : []),
          ...(result.truncated?.length ? [`Only the first part was read (too long): ${result.truncated.map((f) => f.title).join(', ')}`] : []),
        ]
        setMessages((m) => [...m, { role: 'assistant', content: result.answer, notes }])
        setConversationFiles(result.files)
        setChips((c) => c.filter((x) => x.status !== 'ready'))
      } catch (err) {
        // Nothing was saved: take the question back out of the list and into the box so it can be re-sent.
        setMessages((m) => [...m.slice(0, -1), { role: 'assistant', error: errorText(err) }])
        restoreText?.()
      } finally {
        setBusy(false)
      }
    },
    [chips, conversationId, conversationFiles.length]
  )

  const attachStored = (file) => {
    setChips((c) => (c.some((x) => x.id === file.id) ? c : [...c, { key: `stored-${file.id}`, id: file.id, title: file.title, reportDate: file.reportDate, sizeBytes: file.sizeBytes, status: 'ready', progress: 1 }]))
    setView('chat')
  }

  if (!isOpen) {
    return (
      <button
        type="button"
        onClick={() => open(true)}
        className="fixed bottom-6 right-6 z-[60] w-14 h-14 rounded-full bg-primary-container text-on-primary-container shadow-xl flex items-center justify-center material-symbols-outlined text-2xl hover:scale-105 transition-transform"
        aria-label="Open Assistant"
        title="Assistant"
      >
        smart_toy
      </button>
    )
  }

  return (
    <div
      role="dialog"
      aria-label="Assistant"
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
        setView('chat')
        addFilesRef.current?.(e.dataTransfer.files)
      }}
      className="fixed bottom-6 right-6 z-[60] w-[380px] h-[600px] max-h-[80vh] max-w-[90vw] max-sm:inset-0 max-sm:bottom-0 max-sm:right-0 max-sm:w-full max-sm:h-full max-sm:max-h-none max-sm:max-w-none max-sm:rounded-none bg-[#0d1728] border border-[#243248] rounded-xl shadow-2xl flex flex-col overflow-hidden animate-slide-up"
    >
      <div className="flex items-center justify-between px-md py-sm border-b border-outline-variant bg-surface-container-low">
        <span className="font-medium text-on-surface">{view === 'files' ? 'My files' : 'Assistant'}</span>
        <div className="flex items-center gap-xs">
          <button type="button" onClick={() => setView(view === 'files' ? 'chat' : 'files')} className={`p-sm rounded-lg hover:bg-surface-container-highest ${view === 'files' ? 'text-primary' : 'text-on-surface-variant'}`} aria-label={view === 'files' ? 'Back to the chat' : 'My files'} title={view === 'files' ? 'Back to the chat' : 'My files'}>
            <span className="material-symbols-outlined">{view === 'files' ? 'chat' : 'folder_open'}</span>
          </button>
          <button type="button" onClick={newChat} disabled={busy} className="p-sm rounded-lg hover:bg-surface-container-highest text-on-surface-variant disabled:opacity-50" aria-label="New chat" title="New chat">
            <span className="material-symbols-outlined">edit_square</span>
          </button>
          <button type="button" onClick={() => open(false)} className="p-sm rounded-lg hover:bg-surface-container-highest text-on-surface-variant" aria-label="Close" title="Close">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
      </div>

      {/* both views stay mounted, so the typed text, the file chips and the conversation survive a visit to My files */}
      <div className={`${view === 'chat' ? 'flex' : 'hidden'} flex-1 min-h-0 flex-col`}>
        <ChatThread messages={messages} busy={busy} waitingFor={waitingFor} loadError={loadError} conversationFiles={conversationFiles} />
        <ChatComposer chips={chips} setChips={setChips} onSend={send} busy={busy} addFilesRef={addFilesRef} />
      </div>
      {view === 'files' && <FilesPanel conversationFileIds={conversationFiles.map((f) => f.id)} attachedIds={chips.map((c) => c.id).filter(Boolean)} onAttach={attachStored} />}

      {dragging && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/80 border-2 border-dashed border-primary text-on-surface text-sm pointer-events-none animate-fade-in">
          Drop PDF, Excel or CSV files to attach them
        </div>
      )}
    </div>
  )
}
