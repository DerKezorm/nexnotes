/**
 * What an open note does for the notifications (NOTES-14): it tells the server it is in view, so this browser gets no
 * notification about it (AC-9), and it opens at the line a notification named (AC-5).
 */
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Editor } from '@tiptap/react'
import { useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'

import { notifyApi } from './api'
import './notify.css'
import { browserSubscribed } from './browser'

/** How often an open note in view says so again; the server's word holds 75 s. */
export const VIEWING_EVERY_MS = 30_000

/** While the note is open and the page in view, the server hears it every half minute; hidden or closed, it hears
 * "none". Only in a browser signed up for notifications: the others have nothing to hold back. */
export function useViewing(noteId: string, active = true): void {
  useEffect(() => {
    if (!active) return
    let stopped = false
    let timer: ReturnType<typeof setInterval> | null = null
    let said = false
    const say = () => {
      if (stopped) return
      const shown = document.visibilityState !== 'hidden'
      if (!shown && !said) return
      said = shown
      notifyApi.viewing(shown ? noteId : null).catch(() => {})
    }
    void browserSubscribed().then((yes) => {
      if (!yes || stopped) return
      say()
      timer = setInterval(say, VIEWING_EVERY_MS)
      document.addEventListener('visibilitychange', say)
    })
    return () => {
      stopped = true
      if (timer) clearInterval(timer)
      document.removeEventListener('visibilitychange', say)
      if (said) notifyApi.viewing(null).catch(() => {})
    }
  }, [noteId, active])
}

/** The position of the text block number `index` (in the order of the text), or null. The server counts the same
 * blocks (`TEXT_BLOCKS` in `backend/app/services/notify.py`). */
export function textBlockAt(editor: Editor, index: number): number | null {
  let seen = 0
  let found: number | null = null
  editor.state.doc.descendants((node, pos) => {
    if (found !== null) return false
    if (node.isTextblock) {
      if (seen === index) {
        found = pos + 1 + node.content.size
        return false
      }
      seen += 1
      return false
    }
    return true
  })
  return found
}

/** How long the line a notification named stays marked. */
export const CHANGE_MARK_MS = 4000

/** The mark on that line: a decoration of the editor, not a class set on its element. ProseMirror draws a block again
 * when something changes its element from outside, and a class set by hand went with the old element at once. */
export const changeFoundKey = new PluginKey<DecorationSet>('noteChangeFound')

type ChangeMeta = { from: number; to: number } | null

export const ChangeFound = Extension.create({
  name: 'changeFound',
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: changeFoundKey,
        state: {
          init: () => DecorationSet.empty,
          apply: (tr, old) => {
            const meta = tr.getMeta(changeFoundKey) as ChangeMeta | undefined
            if (meta === null) return DecorationSet.empty
            if (meta) return DecorationSet.create(tr.doc, [Decoration.node(meta.from, meta.to, { class: 'nn-change-found' })])
            return old.map(tr.mapping, tr.doc)
          },
        },
        props: { decorations: (state) => changeFoundKey.getState(state) },
      }),
    ]
  },
})

/** `?change=<n>` in the address (a tapped notification): the cursor goes to the end of that line, which comes into
 * view marked for a few seconds, once the note is there. The editor needs `ChangeFound` among its extensions. */
export function useJumpToChange(editor: Editor | null, ready: boolean): void {
  const [params] = useSearchParams()
  const wanted = params.get('change')
  useEffect(() => {
    if (!editor || !ready || wanted === null || !/^\d{1,6}$/.test(wanted)) return
    const pos = textBlockAt(editor, Number(wanted))
    if (pos === null) return
    const block = editor.state.doc.resolve(pos)
    const from = block.before()
    const to = from + block.parent.nodeSize
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos)).setMeta(changeFoundKey, { from, to }).scrollIntoView(),
    )
    const element = editor.view.nodeDOM(from)
    if (element instanceof HTMLElement) element.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
    const unmark = () => {
      if (!editor.isDestroyed && changeFoundKey.getState(editor.state)?.find().length)
        editor.view.dispatch(editor.state.tr.setMeta(changeFoundKey, null))
    }
    const timer = setTimeout(unmark, CHANGE_MARK_MS)
    return () => {
      clearTimeout(timer)
      unmark()
    }
  }, [editor, ready, wanted])
}
