/**
 * The one toolbar over two notes side by side (NOTES-8, decision of 21.11.2026). It holds the tools that work on the
 * text (text style, bold … highlighter, lists, checklist, table, link, quote, code, indenting, divider, undo, redo) and
 * always works on the side used last: what it shows as chosen, possible or locked is that side's, and it changes at once
 * when the other side becomes the one used last. It stands above both sides, outside their scroll areas, so it stays in
 * sight while either text scrolls; a click in it keeps the selection in the editor (no tool takes the focus from it on
 * a click) and never changes the side used last (it is no part of a side). One row or two and "More" as any toolbar
 * (NOTES-3 EC-11). A note one only reads, used last: the tools stand there but cannot be used.
 */
import type { Editor } from '@tiptap/core'
import { useTranslation } from 'react-i18next'

import type { ToolsEntry } from '../editor/sharedTools'
import { Toolbar } from '../editor/Toolbar'
import type { Side } from './state'

/** A number per editor, so that the bar is drawn anew for another editor and never mixes the state of two. */
const editorKeys = new WeakMap<Editor, number>()
let nextKey = 1
function keyOf(editor: Editor): number {
  let key = editorKeys.get(editor)
  if (key === undefined) {
    key = nextKey++
    editorKeys.set(editor, key)
  }
  return key
}

export function SharedToolbar({ entry, side, title }: { entry: ToolsEntry | undefined; side: Side; title: string }) {
  const { t } = useTranslation()
  const label = t('tabs.tools', { title, side: t(`tabs.${side}`) })
  return (
    <div
      className="flex shrink-0 items-center gap-3 border-b border-ink-700 bg-ink-950 px-4 py-2 md:px-5"
      data-testid="shared-toolbar"
      data-side={side}
    >
      <div className="min-w-[34px] flex-1 basis-0">
        {entry ? (
          <Toolbar key={keyOf(entry.editor)} editor={entry.editor} onLink={entry.onLink} part="text" label={label} locked={!entry.writable} />
        ) : (
          // The side used last has no editor (yet, or no longer): the bar keeps its place and its name.
          <div role="toolbar" aria-label={label} aria-disabled data-testid="toolbar" className="h-[34px]" />
        )}
      </div>
      {entry && !entry.writable && (
        <span className="shrink-0 text-[12.5px] text-mist-500" data-testid="shared-toolbar-read">
          {t('editor.tools.readOnly')}
        </span>
      )}
    </div>
  )
}
