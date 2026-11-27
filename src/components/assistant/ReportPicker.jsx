/**
 * The Report popup (every topic except Option Chain): Topic -> Exact NSE report name -> the FILES (upload new ones, and / or
 * pick ones already stored - up to 5 per question) -> an optional word limit -> Questions to analyse. A question can only be
 * picked once a file is ready. Picking copies the question into the message box (it is never sent) and attaches the files
 * to the next message.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getQuestionBank, listFiles, uploadFile, updateFile, errorText, MAX_UPLOAD_BYTES, UPLOAD_EXTENSIONS, UPLOAD_ACCEPT } from '../../services/api'
import Spinner from '../Spinner'
import { PickerShell, Field, fieldClass, LoadState, QuestionList } from './pickerParts'
import { findReports, findQuestions, reportTopics, filesForReport, reportQuestionProblem, filesLeft, pickedContext, MAX_FILES_PER_QUESTION, WORD_LIMIT_RANGE } from './questionBank'

const extensionOf = (name) => (/\.([A-Za-z0-9]+)$/.exec(name)?.[1] || '').toLowerCase()
const formatSize = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`)

function StoredFile({ file, selected, disabled, onSelect }) {
  return (
    <li>
      <button type="button" onClick={() => onSelect(file)} aria-pressed={selected} disabled={disabled && !selected} className={`w-full text-left rounded-lg border px-md py-xs text-xs flex items-center gap-xs disabled:opacity-50 ${selected ? 'border-primary bg-surface-container-highest' : 'border-outline-variant bg-surface-container-low hover:bg-surface-container-highest'}`}>
        <span className="flex-1 min-w-0 truncate text-on-surface" title={file.fileName}>{file.title}</span>
        <span className="text-[11px] text-on-surface-variant shrink-0">{file.reportDate || 'no date'} · {formatSize(file.sizeBytes)}</span>
      </button>
    </li>
  )
}

/** attachedCount = files already waiting for the next question (they count towards the limit of 5). */
export default function ReportPicker({ onPick, onClose, attachedCount = 0 }) {
  const [topics, setTopics] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [topic, setTopic] = useState('')
  const [report, setReport] = useState('')
  const [stored, setStored] = useState(null)
  const [files, setFiles] = useState([]) // the chosen files: { key, id?, title, fileName, reportDate, sizeBytes, status: 'uploading' | 'ready' | 'error', progress, message }
  const nextKey = useRef(1)
  const [reportDate, setReportDate] = useState('')
  const [wordLimit, setWordLimit] = useState('')
  const [problem, setProblem] = useState('')
  const inputRef = useRef(null)

  const load = useCallback(() => {
    setLoadError('')
    getQuestionBank().then(setTopics).catch((err) => setLoadError(errorText(err)))
  }, [])
  useEffect(load, [load])
  const loadStored = useCallback(() => listFiles().then(setStored).catch(() => setStored([])), [])
  useEffect(() => {
    loadStored()
  }, [loadStored])

  const topicList = useMemo(() => reportTopics(topics), [topics])
  const reports = useMemo(() => findReports(topicList, topic), [topicList, topic])
  const questions = useMemo(() => findQuestions(topicList, topic, report), [topicList, topic, report])
  const { matching, others } = useMemo(() => filesForReport(stored, report), [stored, report])

  const chooseTopic = (value) => {
    setTopic(value)
    setProblem('')
    const list = findReports(topicList, value)
    setReport(list.length === 1 ? list[0].report : '') // a topic with one report needs no second choice
  }

  const room = filesLeft(attachedCount) // how many more files the next question can take
  const counted = files.filter((f) => f.status !== 'error').length
  const patch = (key, fields) => setFiles((list) => list.map((f) => (f.key === key ? { ...f, ...fields } : f)))
  const remove = (key) => setFiles((list) => list.filter((f) => f.key !== key))

  const upload = (chosen) => {
    let free = room - counted
    for (const one of Array.from(chosen)) {
      const key = `u${nextKey.current++}`
      const base = { key, title: one.name.replace(/\.[^.]+$/, ''), fileName: one.name, reportDate: null, sizeBytes: one.size, progress: 0 }
      if (!UPLOAD_EXTENSIONS.includes(extensionOf(one.name))) {
        setFiles((list) => [...list, { ...base, status: 'error', message: `Unsupported type - use ${UPLOAD_EXTENSIONS.map((e) => `.${e}`).join(', ')}` }])
        continue
      }
      if (one.size > MAX_UPLOAD_BYTES) {
        setFiles((list) => [...list, { ...base, status: 'error', message: `Larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB` }])
        continue
      }
      if (free <= 0) {
        setFiles((list) => [...list, { ...base, status: 'error', message: `Only ${MAX_FILES_PER_QUESTION} files can go with one question - not added` }])
        continue
      }
      free -= 1
      setFiles((list) => [...list, { ...base, status: 'uploading' }])
      setProblem('')
      uploadFile(one, { reportDate: reportDate || undefined, reportName: report, onProgress: (progress) => patch(key, { progress }) })
        .then(({ file: s, duplicate }) => {
          // The same stored file chosen twice (or already ticked in the list) is kept once.
          setFiles((list) => (list.some((f) => f.id === s.id) ? list.filter((f) => f.key !== key) : list.map((f) => (f.key === key ? { ...f, id: s.id, title: s.title, fileName: s.fileName, reportDate: s.reportDate, sizeBytes: s.sizeBytes, status: 'ready', message: duplicate ? 'Already stored - using the existing copy.' : null } : f))))
          loadStored()
        })
        .catch((err) => patch(key, { status: 'error', message: errorText(err) }))
    }
  }

  const toggleStored = (f) => {
    setProblem('')
    if (files.some((x) => x.id === f.id)) return setFiles((list) => list.filter((x) => x.id !== f.id))
    if (counted >= room) return
    setFiles((list) => [...list, { key: `s${f.id}`, id: f.id, title: f.title, fileName: f.fileName, reportDate: f.reportDate, sizeBytes: f.sizeBytes, status: 'ready' }])
    if (report && !f.reportName) updateFile(f.id, { reportName: report }).then(loadStored).catch(() => {}) // remember which report it is for; best effort
  }

  const pick = (question) => {
    const why = reportQuestionProblem({ files, wordLimit })
    if (why) return setProblem(why)
    const ready = files.filter((f) => f.status === 'ready').map(({ id, title, fileName, reportDate: date, sizeBytes }) => ({ id, title, fileName, reportDate: date, sizeBytes }))
    onPick(question.text, pickedContext({ topic, wordLimit }), ready)
    onClose()
  }

  const canUpload = Boolean(report)
  return (
    <PickerShell title="Report questions" description="Pick a topic and an NSE report, add the file, then a question. The question is copied into the message box and the file is attached — edit, then send." onClose={onClose}>
      <LoadState topics={topics} loadError={loadError} onRetry={load} />
      {topics && (
        <>
          <div className="grid gap-md sm:grid-cols-2">
            <Field label="Topic">
              <select value={topic} onChange={(e) => chooseTopic(e.target.value)} className={fieldClass} aria-label="Topic">
                <option value="">Select a topic</option>
                {topicList.map((t) => <option key={t.topic} value={t.topic}>{t.topic}</option>)}
              </select>
            </Field>
            <Field label="Exact NSE report name">
              <select value={report} onChange={(e) => { setReport(e.target.value); setProblem('') }} disabled={!topic} className={fieldClass} aria-label="Exact NSE report name">
                <option value="">{topic ? 'Select a report' : 'Select a topic first'}</option>
                {reports.map((r) => <option key={r.report} value={r.report}>{r.report}</option>)}
              </select>
            </Field>
          </div>

          <fieldset className="flex flex-col gap-xs rounded-lg border border-outline-variant p-md" disabled={!canUpload}>
            <legend className="px-xs text-[11px] uppercase tracking-wide text-on-surface-variant">Files for this report (up to {room} for this question)</legend>
            {!canUpload && <p className="text-sm text-on-surface-variant">Select a topic and a report first.</p>}
            {canUpload && room === 0 && <p className="text-sm text-bearish">{MAX_FILES_PER_QUESTION} files are already attached to the next question. Remove one to add another.</p>}
            {canUpload && (
              <>
                <div className="flex items-end gap-md flex-wrap">
                  <button type="button" onClick={() => inputRef.current?.click()} disabled={counted >= room} className="h-9 px-md rounded-lg border border-outline-variant text-sm text-on-surface flex items-center gap-xs hover:bg-surface-container-highest disabled:opacity-50">
                    <span className="material-symbols-outlined text-[18px]">upload_file</span>
                    Upload files
                  </button>
                  <input ref={inputRef} type="file" multiple accept={UPLOAD_ACCEPT} className="hidden" aria-label="Choose files to upload" onChange={(e) => { upload(e.target.files); e.target.value = '' }} />
                  <Field label="Report date (optional)">
                    <input type="date" value={reportDate} onChange={(e) => setReportDate(e.target.value)} className={`${fieldClass} w-auto`} aria-label="Report date of the files to upload" />
                  </Field>
                </div>
                {files.length > 0 && (
                  <ul className="flex flex-col gap-xs" aria-label="Chosen files">
                    {files.map((f) => (
                      <li key={f.key} className={`text-xs rounded-lg border px-md py-xs flex items-center gap-xs flex-wrap ${f.status === 'error' ? 'border-bearish text-bearish' : 'border-primary text-on-surface'}`}>
                        <span className="font-medium truncate max-w-[40%]" title={f.fileName}>{f.title}</span>
                        <span className="text-on-surface-variant">{formatSize(f.sizeBytes)}</span>
                        {f.status === 'uploading' && <span className="inline-flex items-center gap-xs text-on-surface-variant"><Spinner />Uploading {Math.round((f.progress || 0) * 100)}%</span>}
                        {f.status === 'ready' && <span className="text-on-surface-variant">ready{f.reportDate ? ` · dated ${f.reportDate}` : ''}{f.message ? ` · ${f.message}` : ''}</span>}
                        {f.status === 'error' && <span>{f.message}</span>}
                        <button type="button" onClick={() => remove(f.key)} aria-label={`Remove ${f.title}`} className="ml-auto text-on-surface-variant hover:text-on-surface">✕</button>
                      </li>
                    ))}
                  </ul>
                )}
                {stored === null ? <Spinner /> : (
                  <>
                    {matching.length > 0 && (
                      <div className="flex flex-col gap-xs">
                        <span className="text-[11px] text-on-surface-variant">Stored files for “{report}” — click to add or remove</span>
                        <ul className="flex flex-col gap-xs max-h-[120px] overflow-y-auto">{matching.map((f) => <StoredFile key={f.id} file={f} selected={files.some((x) => x.id === f.id)} disabled={counted >= room} onSelect={toggleStored} />)}</ul>
                      </div>
                    )}
                    {others.length > 0 && (
                      <details className="text-xs" open={matching.length === 0}>
                        <summary className="cursor-pointer text-on-surface-variant">{matching.length ? 'Other stored files' : 'Stored files — click to add or remove'} ({others.length})</summary>
                        <ul className="flex flex-col gap-xs mt-xs max-h-[120px] overflow-y-auto">{others.map((f) => <StoredFile key={f.id} file={f} selected={files.some((x) => x.id === f.id)} disabled={counted >= room} onSelect={toggleStored} />)}</ul>
                      </details>
                    )}
                    {matching.length + others.length === 0 && <p className="text-xs text-on-surface-variant">No stored files yet — upload some.</p>}
                  </>
                )}
              </>
            )}
          </fieldset>

          {topic && (
            <div className="max-w-[240px]">
              <Field label="Word limit (optional)">
                <input type="number" min={WORD_LIMIT_RANGE[0]} max={WORD_LIMIT_RANGE[1]} value={wordLimit} onChange={(e) => { setWordLimit(e.target.value); setProblem('') }} placeholder={`${WORD_LIMIT_RANGE[0]}–${WORD_LIMIT_RANGE[1]} words`} className={fieldClass} aria-label="Word limit" />
              </Field>
            </div>
          )}

          <QuestionList questions={report ? questions : null} onPick={pick} emptyText={topic ? 'Select a report to see its questions.' : 'Select a topic and a report to see the questions.'} problem={problem} />
        </>
      )}
    </PickerShell>
  )
}
