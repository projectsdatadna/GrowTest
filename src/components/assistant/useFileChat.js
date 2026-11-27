/**
 * State and actions of the file chat: the conversation (id kept in localStorage so a refresh restores it),
 * its messages and files, the files waiting to be sent, and sending a question. The page that shows it
 * is AssistantTab. Each question goes with the conversation id and file ids; the server loads those files
 * from Firestore and sends them with the question to the model.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { sendChat, getConversation, errorText } from '../../services/api'

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

export default function useFileChat() {
  const [conversationId, setConversationId] = useState(() => read(CONVERSATION_KEY))
  const [messages, setMessages] = useState([])
  const [conversationFiles, setConversationFiles] = useState([]) // files the conversation uses
  const [chips, setChips] = useState([]) // files waiting to be sent with the next message
  const [chatContext, setChatContext] = useState({ optionChain: null, wordLimit: null }) // from the + picker; goes with every question until removed
  const [busy, setBusy] = useState(false)
  const [waitingFor, setWaitingFor] = useState('')
  const [loadError, setLoadError] = useState('')
  const restored = useRef(false)

  // Bring back the saved conversation when the page opens.
  useEffect(() => {
    if (restored.current || !conversationId) return
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
  }, [conversationId])

  const newChat = useCallback(() => {
    if (busy) return
    restored.current = true
    setConversationId(null)
    write(CONVERSATION_KEY, null)
    setMessages([])
    setConversationFiles([])
    setChips([])
    setChatContext({ optionChain: null, wordLimit: null })
    setLoadError('')
  }, [busy])

  const send = useCallback(
    async (question, restoreText) => {
      const ready = chips.filter((c) => c.status === 'ready')
      setMessages((m) => [...m, { role: 'user', content: question, files: ready.map((c) => c.title) }])
      setWaitingFor(chatContext.optionChain ? (chatContext.optionChain.asOf ? 'Reading the saved option chain…' : 'Fetching the option chain…') : ready.length || conversationFiles.length ? 'Reading the files…' : 'Thinking…')
      setBusy(true)
      try {
        const result = await sendChat({ message: question, conversationId, fileIds: ready.map((c) => c.id), ...chatContext })
        setConversationId(result.conversationId)
        write(CONVERSATION_KEY, result.conversationId)
        const notes = [
          ...result.newlyAttached.filter((f) => f.auto).map((f) => `${f.role ? `Added the ${f.role} version` : 'Added by date'}: ${f.title}${f.reportDate ? ` (${f.reportDate})` : ''}`),
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
    [chips, conversationId, conversationFiles.length, chatContext]
  )

  const attachStored = useCallback((file) => {
    setChips((c) => (c.some((x) => x.id === file.id) ? c : [...c, { key: `stored-${file.id}`, id: file.id, title: file.title, fileName: file.fileName, reportDate: file.reportDate, sizeBytes: file.sizeBytes, status: 'ready', progress: 1 }]))
  }, [])

  return { messages, conversationFiles, chips, setChips, chatContext, setChatContext, busy, waitingFor, loadError, send, newChat, attachStored }
}
