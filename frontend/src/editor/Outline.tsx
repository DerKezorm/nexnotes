/**
 * The outline of a note (NOTES-3 AC-15): the headings of the note, indented by level, a click goes there and the arrow
 * folds or opens the section (the `collapsed` of AC-12, nothing new in the note); below it the note's tags and what
 * the line under the title says. It follows every change, also those of others (the editor's own document, which Yjs
 * keeps up to date).
 *
 * Beside the text where the side has room (a column), otherwise a narrow panel over the text's right edge (third
 * review): it takes the focus, Escape gives it back to the outline button, a click beside it closes it. Both stay in
 * sight while the note scrolls, below the note's toolbar (`--nn-head-h`).
 */
import type { Editor } from '@tiptap/core'
import { useEditorState } from '@tiptap/react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'

import { toggleFold } from './extensions'
import { headingsOf, type Heading } from './outlineData'
import { openTag, tagsInDoc } from './tags'

/** The outline button of a side (its toolbar's, or the entry in "More"); null when neither is on the screen. */
function toggleButton(id: string): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>('[data-outline-toggle]')].find((element) => element.dataset.outlineToggle === id) ?? null
}

export function Outline({
  editor,
  info,
  panel,
}: {
  editor: Editor
  info: { label: string; text: string }[]
  /** As a panel over the text: how it closes, and the id of the button that opens it. */
  panel?: { onClose: () => void; toggleId: string }
}) {
  const { t } = useTranslation()
  const box = useRef<HTMLElement>(null)
  const close = useRef(panel?.onClose)
  useEffect(() => {
    close.current = panel?.onClose
  })
  const asPanel = Boolean(panel)
  const toggleId = panel?.toggleId ?? ''
  // The panel takes the focus when it opens, and closes on a click beside it (its own button toggles it itself).
  useEffect(() => {
    if (!asPanel) return
    box.current?.focus({ preventScroll: true })
    const outside = (event: PointerEvent) => {
      const target = event.target as Element | null
      if (!target || box.current?.contains(target)) return
      if (target.closest?.<HTMLElement>('[data-outline-toggle]')?.dataset.outlineToggle === toggleId) return
      close.current?.()
    }
    window.addEventListener('pointerdown', outside, true)
    return () => window.removeEventListener('pointerdown', outside, true)
  }, [asPanel, toggleId])
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
    close.current?.()
  }
  const keys = (event: ReactKeyboardEvent) => {
    if (!asPanel || event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    close.current?.()
    const button = toggleButton(toggleId)
    if (button) button.focus()
    else editor.commands.focus()
  }
  const content = (
    <>
      <nav aria-label={t('editor.outline.headings')}>
        <p className="mb-1.5 text-[11px] font-semibold tracking-wide text-mist-500 uppercase">{t('editor.outline.headings')}</p>
        {state.headings.length === 0 ? (
          <p className="leading-relaxed text-mist-500" data-testid="outline-none">
            {t('editor.outline.none')}
          </p>
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
              <button
                key={tag}
                type="button"
                onClick={() => {
                  close.current?.()
                  openTag(tag)
                }}
                className="nn-tag rounded-md bg-accent-wash px-1.5 py-0.5 text-accent-400 hover:underline"
                data-testid="outline-tag"
              >
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
    </>
  )
  // Below the note's toolbar, which stays at the top while the note scrolls.
  const top = 'calc(var(--nn-head-h, 0px) + 16px)'
  if (!panel)
    return (
      <aside
        ref={box}
        aria-label={t('editor.outline.label')}
        className="nn-scroll sticky flex max-h-[calc(100dvh-var(--nn-head-h,0px)-8rem)] w-[240px] shrink-0 flex-col gap-5 overflow-y-auto pt-6 pr-4 text-[13px]"
        style={{ top }}
        data-testid="outline"
        data-mode="column"
      >
        {content}
      </aside>
    )
  return (
    <div className="pointer-events-none absolute inset-y-0 right-0 z-10 flex w-[min(280px,100%)] items-start md:top-5 md:right-6">
      <aside
        ref={box}
        tabIndex={-1}
        aria-label={t('editor.outline.label')}
        onKeyDown={keys}
        className="nn-scroll pointer-events-auto sticky flex max-h-[calc(100dvh-var(--nn-head-h,0px)-8rem)] w-full flex-col gap-5 overflow-y-auto rounded-[12px] border border-ink-700 bg-ink-900 p-4 text-[13px] shadow-xl shadow-black/25 outline-offset-[-2px]"
        style={{ top }}
        data-testid="outline"
        data-mode="panel"
      >
        {content}
      </aside>
    </div>
  )
}
