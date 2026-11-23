/**
 * Renders an assistant answer without innerHTML: paragraphs, "- " / "1." lists, **bold**, and
 * source citations like [2] or [1][3] as small buttons that open that source.
 */

import { Fragment } from 'react'

const INLINE = /(\*\*[^*]+\*\*|\[\d+(?:\s*,\s*\d+)*\])/g

function Inline({ text, sources, onCite }) {
  return text.split(INLINE).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>
    const cite = /^\[(\d+(?:\s*,\s*\d+)*)\]$/.exec(part)
    if (!cite) return <Fragment key={i}>{part}</Fragment>
    return cite[1].split(',').map((raw) => {
      const n = Number(raw)
      const source = sources?.find((s) => s.n === n)
      if (!source) return <Fragment key={`${i}-${n}`}>[{n}]</Fragment>
      return (
        <button
          key={`${i}-${n}`}
          type="button"
          onClick={() => onCite?.(n)}
          title={`${source.title}${source.reportDate ? ` · ${source.reportDate}` : ''} · p.${source.page}`}
          className="mx-[1px] px-[5px] rounded text-[10px] font-mono align-baseline border border-outline-variant text-primary hover:bg-surface-container-highest"
        >
          {n}
        </button>
      )
    })
  })
}

export default function AnswerText({ text, sources, onCite }) {
  const lines = String(text || '').split('\n')
  const blocks = []
  let list = null
  for (const line of lines) {
    const item = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line)
    if (item) {
      if (!list) {
        list = { type: 'list', ordered: /^\s*\d/.test(line), items: [] }
        blocks.push(list)
      }
      list.items.push(item[1])
    } else {
      list = null
      if (line.trim()) blocks.push({ type: 'p', text: line })
    }
  }
  return (
    <div className="flex flex-col gap-xs text-sm leading-relaxed">
      {blocks.map((block, i) =>
        block.type === 'p' ? (
          <p key={i}><Inline text={block.text} sources={sources} onCite={onCite} /></p>
        ) : (
          <ul key={i} className={`${block.ordered ? 'list-decimal' : 'list-disc'} pl-lg flex flex-col gap-[2px]`}>
            {block.items.map((it, j) => (
              <li key={j}><Inline text={it} sources={sources} onCite={onCite} /></li>
            ))}
          </ul>
        )
      )}
    </div>
  )
}
