/**
 * Renders an assistant answer without innerHTML: paragraphs, "- " / "1." lists and **bold**.
 */

import { Fragment } from 'react'

const BOLD = /(\*\*[^*]+\*\*)/g

const Inline = ({ text }) =>
  text.split(BOLD).map((part, i) => (part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : <Fragment key={i}>{part}</Fragment>))

export default function AnswerText({ text }) {
  const blocks = []
  let list = null
  for (const line of String(text || '').split('\n')) {
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
    <div className="flex flex-col gap-xs text-sm leading-relaxed break-words">
      {blocks.map((block, i) =>
        block.type === 'p' ? (
          <p key={i}><Inline text={block.text} /></p>
        ) : (
          <ul key={i} className={`${block.ordered ? 'list-decimal' : 'list-disc'} pl-lg flex flex-col gap-[2px]`}>
            {block.items.map((it, j) => (
              <li key={j}><Inline text={it} /></li>
            ))}
          </ul>
        )
      )}
    </div>
  )
}
