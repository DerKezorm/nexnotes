/**
 * The outline beside the text on a wide screen (NOTES-3 AC-15): the headings of the note, indented by level, a click
 * goes there and the arrow folds or opens the section (the `collapsed` of AC-12, nothing new in the note); below it
 * the note's tags and what the line under the title says. It follows every change, also those of others (the
 * editor's own document, which Yjs keeps up to date).
 */
import type { Editor } from '@tiptap/core'
import { useEditorState } from '@tiptap/react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { toggleFold } from './extensions'
import { headingsOf, type Heading } from './outlineData'
import { openTag, tagsInDoc } from './tags'

export function Outline({ editor, info }: { editor: Editor; info: { label: string; text: string }[] }) {
  const { t } = useTranslation()
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const doc = current.state.doc
      return { headings: headingsOf(doc), tags: [...new Set(tagsInDoc(doc).map((tag) => tag.label))], key: JSON.stringify(headingsOf(doc)) + tagsInDoc(doc).map((tag) => tag.label).join(' ') }
    },
    equalityFn: (a, b) => a?.key === b?.key,
  })
  if (!state) return null
  const go = (heading: Heading) => {
    editor.chain().focus().setTextSelection(heading.pos + 1 + heading.text.length).scrollIntoView().run()
  }
  return (
    <aside aria-label={t('editor.outline.label')} className="sticky top-4 flex max-h-[calc(100dvh-8rem)] w-[260px] shrink-0 flex-col gap-5 overflow-y-auto pt-6 pr-4 text-[13px]" data-testid="outline">
      <nav aria-label={t('editor.outline.headings')}>
        <p className="mb-1.5 text-[11px] font-semibold tracking-wide text-mist-500 uppercase">{t('editor.outline.headings')}</p>
        {state.headings.length === 0 ? (
          <p className="text-mist-500">{t('editor.outline.none')}</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {state.headings.map((heading) => (
              <li key={heading.pos} className="flex min-w-0 items-center gap-0.5" style={{ paddingLeft: (heading.level - 1) * 14 }} data-testid="outline-heading" data-level={heading.level}>
                <button
                  type="button"
                  aria-label={heading.collapsed ? t('editor.fold.open') : t('editor.fold.close')}
                  aria-expanded={!heading.collapsed}
                  onClick={() => toggleFold(editor.view, heading.pos)}
                  className="flex h-6 w-5 shrink-0 items-center justify-center rounded text-mist-500 hover:text-mist-100"
                  data-testid="outline-fold"
                >
                  {heading.collapsed ? <ChevronRight aria-hidden className="h-3.5 w-3.5" /> : <ChevronDown aria-hidden className="h-3.5 w-3.5" />}
                </button>
                <button type="button" onClick={() => go(heading)} className="min-w-0 truncate rounded px-1 py-0.5 text-left text-mist-300 hover:bg-ink-800 hover:text-mist-100" title={heading.text}>
                  {heading.text || t('editor.outline.empty')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </nav>
      {state.tags.length > 0 && (
        <div>
          <p className="mb-1.5 text-[11px] font-semibold tracking-wide text-mist-500 uppercase">{t('editor.outline.tags')}</p>
          <div className="flex flex-wrap gap-1.5">
            {state.tags.map((tag) => (
              <button key={tag} type="button" onClick={() => openTag(tag)} className="nn-tag rounded-md bg-accent-wash px-1.5 py-0.5 text-accent-400 hover:underline" data-testid="outline-tag">
                #{tag}
              </button>
            ))}
          </div>
        </div>
      )}
      <div data-testid="outline-info">
        <p className="mb-1.5 text-[11px] font-semibold tracking-wide text-mist-500 uppercase">{t('editor.outline.info')}</p>
        <dl className="flex flex-col gap-1.5">
          {info.map((row) => (
            <div key={row.label} className="flex flex-col">
              <dt className="text-mist-500">{row.label}</dt>
              <dd className="text-mist-300">{row.text}</dd>
            </div>
          ))}
        </dl>
      </div>
    </aside>
  )
}
