/**
 * An old version as it was, read only (NOTES-15 AC-3): the note's ProseMirror JSON drawn as React elements, with the
 * editor's look (`nn-editor`). Nothing is put into the page as HTML; links keep only http, https and mailto and open
 * in a new tab without a way back to this page. A block this version of nexnotes does not know shows its words.
 * Attachments (NOTES-10) stand as they stood then, also when the note let them go since (NOTES-15 AC-3): they stay
 * as long as the version.
 */
import type { ReactNode } from 'react'

import { AttachmentBlock, LinkCardBlock } from '../attachments/blocks'
import type { LinkCard } from '../attachments/api'
import type { ImageSize } from '../attachments/open'
import { safeHref } from '../editor/extensions'
import '../editor/editor.css'
import type { ProseNode } from './api'

function withMarks(text: ReactNode, marks: ProseNode['marks'], key: string): ReactNode {
  let out = text
  for (const [index, mark] of (marks ?? []).entries()) {
    const k = `${key}-${index}`
    switch (mark.type) {
      case 'bold':
        out = <strong key={k}>{out}</strong>
        break
      case 'italic':
        out = <em key={k}>{out}</em>
        break
      case 'underline':
        out = <u key={k}>{out}</u>
        break
      case 'strike':
        out = <s key={k}>{out}</s>
        break
      case 'code':
        out = <code key={k}>{out}</code>
        break
      case 'highlight': {
        const color = typeof mark.attrs?.color === 'string' ? mark.attrs.color : undefined
        out = (
          <mark key={k} data-color={color}>
            {out}
          </mark>
        )
        break
      }
      case 'link': {
        const href = safeHref(mark.attrs?.href)
        if (href)
          out = (
            <a key={k} href={href} target="_blank" rel="noopener noreferrer">
              {out}
            </a>
          )
        break
      }
    }
  }
  return out
}

function children(node: ProseNode, key: string, noteId: string): ReactNode[] {
  return (node.content ?? []).map((child, index) => draw(child, `${key}.${index}`, noteId))
}

const READ_ONLY = { editable: false }

function draw(node: ProseNode, key: string, noteId: string): ReactNode {
  const inner = () => children(node, key, noteId)
  switch (node.type) {
    case 'text':
      return <span key={key}>{withMarks(node.text ?? '', node.marks, key)}</span>
    case 'hardBreak':
      return <br key={key} />
    case 'paragraph':
      return <p key={key}>{inner()}</p>
    case 'heading': {
      const level = Number(node.attrs?.level) || 1
      if (level === 2) return <h2 key={key}>{inner()}</h2>
      if (level === 3) return <h3 key={key}>{inner()}</h3>
      return <h1 key={key}>{inner()}</h1>
    }
    case 'bulletList':
      return <ul key={key}>{inner()}</ul>
    case 'orderedList':
      return <ol key={key}>{inner()}</ol>
    case 'listItem':
      return <li key={key}>{inner()}</li>
    case 'taskList':
      return (
        <ul key={key} data-type="taskList">
          {inner()}
        </ul>
      )
    case 'taskItem': {
      const checked = node.attrs?.checked === true
      return (
        <li key={key} data-type="taskItem" data-checked={checked ? 'true' : 'false'}>
          <label>
            <input type="checkbox" checked={checked} disabled readOnly />
          </label>
          <div>{inner()}</div>
        </li>
      )
    }
    case 'blockquote':
      return <blockquote key={key}>{inner()}</blockquote>
    case 'codeBlock':
      return (
        <pre key={key}>
          <code>{(node.content ?? []).map((child) => child.text ?? '').join('')}</code>
        </pre>
      )
    case 'horizontalRule':
      return <hr key={key} />
    case 'table':
      return (
        <div key={key} className="tableWrapper">
          <table>
            <tbody>{inner()}</tbody>
          </table>
        </div>
      )
    case 'tableRow':
      return <tr key={key}>{inner()}</tr>
    case 'tableHeader':
      return <th key={key}>{inner()}</th>
    case 'tableCell':
      return <td key={key}>{inner()}</td>
    case 'image':
    case 'attachment': {
      const attrs = (node.attrs ?? {}) as Record<string, string | null>
      return (
        <div key={key} className="nn-attachment-node">
          <AttachmentBlock noteId={noteId} id={attrs.id ?? null} name={attrs.name ?? null} size={(attrs.size as ImageSize | null) ?? undefined} nodeType={node.type} actions={READ_ONLY} />
        </div>
      )
    }
    case 'linkPreview':
      return typeof node.attrs?.href === 'string' && /^https?:\/\//i.test(node.attrs.href) ? (
        <div key={key} className="nn-attachment-node">
          <LinkCardBlock attrs={node.attrs as unknown as LinkCard} actions={READ_ONLY} />
        </div>
      ) : null
    default:
      return (
        <div key={key} data-unknown={node.type}>
          {inner()}
        </div>
      )
  }
}

export function VersionView({ doc, noteId = '' }: { doc: ProseNode; noteId?: string }) {
  return (
    <div className="nn-editor" data-testid="version-body">
      <div className="ProseMirror nn-prose">{children(doc, 'v', noteId)}</div>
    </div>
  )
}
