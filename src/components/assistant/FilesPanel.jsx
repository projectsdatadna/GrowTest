/**
 * "My files": everything stored (kept permanently, with its report date). Attach a file to the current
 * chat, fix its report date, download it, or delete it (deleted files stop being used; the bytes stay).
 */

import { useEffect, useState } from 'react'
import { listFiles, updateFile, deleteFile, fileDownloadUrl, errorText } from '../../services/api'
import Spinner from '../Spinner'

const formatSize = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`)
const dateField = 'bg-surface-container border border-terminal-border rounded px-xs py-[1px] text-[11px] text-on-surface'

function FileRow({ file, inChat, attached, onAttach, onChanged }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const run = async (fn) => {
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <li className="rounded-lg border border-outline-variant px-sm py-xs text-xs flex flex-col gap-[2px]">
      <div className="flex items-center gap-xs">
        <span className="flex-1 min-w-0 truncate text-on-surface" title={file.fileName}>{file.title}</span>
        {file.version?.of > 1 && <span className="text-[10px] px-xs rounded border border-outline-variant text-on-surface-variant shrink-0" title={`Version ${file.version.n} of ${file.version.of} of this document (oldest first)`}>v{file.version.n}</span>}
        <span className="text-[11px] text-on-surface-variant shrink-0">{formatSize(file.sizeBytes)}</span>
      </div>
      {file.reportName && <div className="text-[11px] text-on-surface-variant truncate" title={file.reportName}>NSE report: {file.reportName}</div>}
      <div className="flex items-center gap-xs flex-wrap text-[11px] text-on-surface-variant">
        <label className="flex items-center gap-xs">
          Report date
          <input type="date" defaultValue={file.reportDate || ''} onBlur={(e) => e.target.value !== (file.reportDate || '') && run(async () => { await updateFile(file.id, { reportDate: e.target.value || null }); onChanged() })} aria-label={`Report date of ${file.title}`} className={dateField} />
        </label>
        <span className="ml-auto flex items-center gap-sm">
          {busy && <Spinner />}
          {inChat ? <span>In this chat</span> : attached ? <span>Attached</span> : <button type="button" onClick={() => onAttach(file)} className="text-primary hover:underline">Attach</button>}
          <a href={fileDownloadUrl(file.id)} className="text-primary hover:underline" aria-label={`Download ${file.title}`}>Download</a>
          <button type="button" onClick={() => window.confirm(`Delete “${file.title}”? It will no longer be used in chats.`) && run(async () => { await deleteFile(file.id); onChanged() })} className="text-bearish hover:underline">Delete</button>
        </span>
      </div>
      {error && <div className="text-bearish">{error}</div>}
    </li>
  )
}

/** `refreshKey` changes whenever the list may have changed elsewhere (an upload finished, a message was sent). */
export default function FilesPanel({ conversationFileIds, attachedIds, onAttach, refreshKey = 0 }) {
  const [files, setFiles] = useState(null)
  const [error, setError] = useState('')
  const [bump, setBump] = useState(0)

  useEffect(() => {
    let cancelled = false
    listFiles()
      .then((list) => !cancelled && (setFiles(list), setError('')))
      .catch((err) => !cancelled && setError(errorText(err)))
    return () => {
      cancelled = true
    }
  }, [bump, refreshKey])

  // One section per document (versions of the same file together, newest first); sections in the order of their newest upload.
  const groups = []
  for (const file of files ?? []) {
    const key = file.documentKey || file.id
    const group = groups.find((g) => g.key === key)
    if (group) group.files.push(file)
    else groups.push({ key, files: [file] })
  }
  for (const group of groups) group.files.sort((a, b) => (b.version?.n ?? 0) - (a.version?.n ?? 0))

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-sm flex flex-col gap-xs">
      <p className="text-[11px] text-on-surface-variant">
        Files are kept permanently, each with its own date. Upload a new version of a file any time, then ask “compare the current and previous report”, or name dates (“compare with 10 Nov”).
      </p>
      {error && <div className="text-sm text-bearish">{error}</div>}
      {!files && !error && <Spinner />}
      {files && files.length === 0 && <div className="text-sm text-on-surface-variant">No files yet. Use the paperclip in the chat to upload one.</div>}
      <div className="flex flex-col gap-md">
        {groups.map((group) => (
          <section key={group.key} className="flex flex-col gap-xs" aria-label={`Document ${group.files[0].title}`}>
            {group.files.length > 1 && (
              <h3 className="text-[11px] uppercase tracking-wide text-on-surface-variant">
                {group.files[0].documentKey || group.files[0].title} · {group.files.length} versions
              </h3>
            )}
            <ul className="flex flex-col gap-xs">
              {group.files.map((file) => (
                <FileRow key={`${file.id}:${file.reportDate}`} file={file} inChat={conversationFileIds.includes(file.id)} attached={attachedIds.includes(file.id)} onAttach={onAttach} onChanged={() => setBump((b) => b + 1)} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  )
}
