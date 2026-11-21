/** Rows and columns of a table: added, removed, moved; the other cells keep their content (NOTES-3 AC-5). */
import type { Editor } from '@tiptap/core'
import { moveTableColumn, moveTableRow, selectedRect } from '@tiptap/pm/tables'

/** Runs a prosemirror-tables command on the editor. */
function tableCommand(editor: Editor, make: (rect: ReturnType<typeof selectedRect>) => ((state: Editor['state'], dispatch?: Editor['view']['dispatch']) => boolean) | null): boolean {
  try {
    const rect = selectedRect(editor.state)
    const command = make(rect)
    if (!command) return false
    const done = command(editor.state, editor.view.dispatch)
    editor.view.focus()
    return done
  } catch {
    return false
  }
}

/** The actions of the table menu: rows and columns added, removed, moved (AC-5). */
export function tableActions(editor: Editor) {
  return {
    addRowBefore: () => editor.chain().focus().addRowBefore().run(),
    addRowAfter: () => editor.chain().focus().addRowAfter().run(),
    deleteRow: () => editor.chain().focus().deleteRow().run(),
    addColumnBefore: () => editor.chain().focus().addColumnBefore().run(),
    addColumnAfter: () => editor.chain().focus().addColumnAfter().run(),
    deleteColumn: () => editor.chain().focus().deleteColumn().run(),
    rowUp: () => tableCommand(editor, (rect) => (rect.top > 0 ? moveTableRow({ from: rect.top, to: rect.top - 1 }) : null)),
    rowDown: () => tableCommand(editor, (rect) => (rect.bottom < rect.map.height ? moveTableRow({ from: rect.top, to: rect.top + 1 }) : null)),
    columnLeft: () => tableCommand(editor, (rect) => (rect.left > 0 ? moveTableColumn({ from: rect.left, to: rect.left - 1 }) : null)),
    columnRight: () => tableCommand(editor, (rect) => (rect.right < rect.map.width ? moveTableColumn({ from: rect.left, to: rect.left + 1 }) : null)),
    toggleHeaderRow: () => editor.chain().focus().toggleHeaderRow().run(),
    deleteTable: () => editor.chain().focus().deleteTable().run(),
  }
}

export type TableAction = keyof ReturnType<typeof tableActions>

/** The table's menu, the same at the table, on a right click in a cell and in the toolbar; `null` draws a line. */
export const TABLE_MENU: (TableAction | null)[] = [
  'addRowBefore',
  'addRowAfter',
  'addColumnBefore',
  'addColumnAfter',
  null,
  'rowUp',
  'rowDown',
  'columnLeft',
  'columnRight',
  null,
  'toggleHeaderRow',
  'deleteRow',
  'deleteColumn',
  'deleteTable',
]

/** The table the selection stands in, as the page shows it; none outside a table. */
export function tableAtSelection(editor: Editor): HTMLTableElement | null {
  if (!editor.isActive('table')) return null
  const { from } = editor.state.selection
  try {
    const found = editor.view.domAtPos(from).node
    const element = found instanceof HTMLElement ? found : found.parentElement
    return element?.closest('table') ?? null
  } catch {
    return null
  }
}
