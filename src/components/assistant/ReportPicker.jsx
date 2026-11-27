/**
 * The Report popup (every topic except Option Chain): Topic -> Exact NSE report name -> the FILE (upload a new one, or
 * pick one already stored) -> an optional word limit -> Questions to analyse. A question can only be picked once a
 * file is chosen. Picking copies the question into the message box (it is never sent) and attaches the file to the
 * next message.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getQuestionBank, listFiles, uploadFile, updateFile, errorText, MAX_UPLOAD_BYTES, UPLOAD_EXTENSIONS } from '../../services/api'
import Spinner from '../Spinner'
import { PickerShell, Field, fieldClass, LoadState, QuestionList } from './pickerParts'
import { findReports, findQuestions, reportTopics, filesForReport, reportQuestionProblem, pickedContext, WORD_LIMIT_RANGE } from './questionBank'

const extensionOf = (name) => (/\.([A-Za-z0-9]+)$/.exec(name)?.[1] || '').toLowerCase()
const formatSize = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`)

function StoredFile({ file, selected, onSelect }) {
  return (
    <li>
      <button type="button" onClick={() => onSelect(file)} aria-pressed={selected} className={`w-full text-left rounded-lg border px-md py-xs text-xs flex items-center gap-xs ${selected ? 'border-primary bg-surface-container-highest' : 'border-outline-variant bg-surface-container-low hover:bg-surface-container-highest'}`}>
        <span className="flex-1 min-w-0 truncate text-on-surface" title={file.fileName}>{file.title}</span>
        <span className="text-[11px] text-on-surface-variant shrink-0">{file.reportDate || 'no date'} · {formatSize(file.sizeBytes)}</span>
      </button>
    </li>
  )
}

export default function ReportPicker({ onPick, onClose }) {
  const [topics, setTopics] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [topic, setTopic] = useState('')
  const [report, setReport] = useState('')
  const [stored, setStored] = useState(null)
  const [file, setFile] = useState(null) // { id?, title, reportDate, sizeBytes, status: 'uploading' | 'ready' | 'error', progress, message }
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

  const upload = (chosen) => {
    if (!chosen) return
    const base = { title: chosen.name.replace(/\.[^.]+$/, ''), reportDate: null, sizeBytes: chosen.size, progress: 0 }
    if (!UPLOAD_EXTENSIONS.includes(extensionOf(chosen.name))) return setFile({ ...base, status: 'error', message: `Unsupported type - use ${UPLOAD_EXTENSIONS.map((e) => `.${e}`).join(', ')}` })
    if (chosen.size > MAX_UPLOAD_BYTES) return setFile({ ...base, status: 'error', message: `Larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB` })
    setFile({ ...base, status: 'uploading' })
    setProblem('')
    uploadFile(chosen, { reportDate: reportDate || undefined, reportName: report, onProgress: (progress) => setFile((f) => (f?.status === 'uploading' ? { ...f, progress } : f)) })
      .then(({ file: s, duplicate }) => {
        setFile({ id: s.id, title: s.title, reportDate: s.reportDate, sizeBytes: s.sizeBytes, status: 'ready', message: duplicate ? 'Already stored - using the existing copy.' : null })
        loadStored()
      })
      .catch((err) => setFile({ ...base, status: 'error', message: errorText(err) }))
  }

  const selectStored = (f) => {
    setFile({ id: f.id, title: f.title, reportDate: f.reportDate, sizeBytes: f.sizeBytes, status: 'ready' })
    setProblem('')
    if (report && !f.reportName) updateFile(f.id, { reportName: report }).then(loadStored).catch(() => {}) // remember which report it is for; best effort
  }

  const pick = (question) => {
    const why = reportQuestionProblem({ file, wordLimit })
    if (why) return setProblem(why)
    const { id, title, reportDate: date, sizeBytes } = file
    onPick(question.text, pickedContext({ topic, wordLimit }), [{ id, title, reportDate: date, sizeBytes }])
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
            <legend className="px-xs text-[11px] uppercase tracking-wide text-on-surface-variant">File for this report</legend>
            {!canUpload && <p className="text-sm text-on-surface-variant">Select a topic and a report first.</p>}
            {canUpload && (
              <>
                <div className="flex items-end gap-md flex-wrap">
                  <button type="button" onClick={() => inputRef.current?.click()} className="h-9 px-md rounded-lg border border-outline-variant text-sm text-on-surface flex items-center gap-xs hover:bg-surface-container-highest">
                    <span className="material-symbols-outlined text-[18px]">upload_file</span>
                    Upload a file
                  </button>
                  <input ref={inputRef} type="file" accept=".pdf,.xlsx,.csv" className="hidden" aria-label="Choose a file to upload" onChange={(e) => { upload(e.target.files[0]); e.target.value = '' }} />
                  <Field label="Report date (optional)">
                    <input type="date" value={reportDate} onChange={(e) => setReportDate(e.target.value)} className={`${fieldClass} w-auto`} aria-label="Report date of the file to upload" />
                  </Field>
                </div>
                {file && (
                  <div className={`text-xs rounded-lg border px-md py-xs ${file.status === 'error' ? 'border-bearish text-bearish' : 'border-primary text-on-surface'}`} role="status">
                    <span className="font-medium">{file.title}</span> · {formatSize(file.sizeBytes)}
                    {file.status === 'uploading' && <span className="inline-flex items-center gap-xs ml-sm text-on-surface-variant"><Spinner />Uploading {Math.round((file.progress || 0) * 100)}%</span>}
                    {file.status === 'ready' && <span className="ml-sm text-on-surface-variant">ready{file.reportDate ? ` · dated ${file.reportDate}` : ''}{file.message ? ` · ${file.message}` : ''}</span>}
                    {file.status === 'error' && <span className="ml-sm">{file.message}</span>}
                  </div>
                )}
                {stored === null ? <Spinner /> : (
                  <>
                    {matching.length > 0 && (
                      <div className="flex flex-col gap-xs">
                        <span className="text-[11px] text-on-surface-variant">Stored files for “{report}”</span>
                        <ul className="flex flex-col gap-xs max-h-[120px] overflow-y-auto">{matching.map((f) => <StoredFile key={f.id} file={f} selected={file?.id === f.id} onSelect={selectStored} />)}</ul>
                      </div>
                    )}
                    {others.length > 0 && (
                      <details className="text-xs" open={matching.length === 0}>
                        <summary className="cursor-pointer text-on-surface-variant">{matching.length ? 'Other stored files' : 'Stored files'} ({others.length})</summary>
                        <ul className="flex flex-col gap-xs mt-xs max-h-[120px] overflow-y-auto">{others.map((f) => <StoredFile key={f.id} file={f} selected={file?.id === f.id} onSelect={selectStored} />)}</ul>
                      </details>
                    )}
                    {matching.length + others.length === 0 && <p className="text-xs text-on-surface-variant">No stored files yet — upload one.</p>}
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
