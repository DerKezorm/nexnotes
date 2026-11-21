/**
 * Rows and columns of a table: added, removed, moved; the other cells keep their content (NOTES-3 AC-5). Column widths
 * (AC-19) are the cells' `colwidth` in pixels, as Tiptap has it; a table without widths has equal columns over the
 * text's width.
 */
import type { Editor } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { TableMap, cellAround, columnResizingPluginKey, moveTableColumn, moveTableRow, selectedRect } from '@tiptap/pm/tables'
import type { EditorView } from '@tiptap/pm/view'

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
    columnWider: () => changeColumnWidth(editor, WIDTH_STEP),
    columnNarrower: () => changeColumnWidth(editor, -WIDTH_STEP),
    columnFit: () => fitColumnAtSelection(editor),
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
  'columnWider',
  'columnNarrower',
  'columnFit',
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

// --- Column widths (AC-19) ------------------------------------------------------------------------------------------

/** No column narrower than this. */
export const COLUMN_MIN = 60
/** One step of "wider" and "narrower" in the table menu. */
export const WIDTH_STEP = 40
/** Fitting a column to its content goes no wider than this. */
const COLUMN_FIT_MAX = 900

/** The width of each column of a table as the page shows it now; 0 where the page cannot tell (no layout). */
function shownWidths(view: EditorView, table: PMNode, tablePos: number): number[] {
  const map = TableMap.get(table)
  const widths: number[] = []
  for (let col = 0; col < map.width; col++) {
    let width = 0
    for (let row = 0; row < map.height && !width; row++) {
      const cellPos = map.map[row * map.width + col]
      const cell = table.nodeAt(cellPos)
      if (!cell || cell.attrs.colspan !== 1) continue
      const dom = view.nodeDOM(tablePos + 1 + cellPos)
      if (dom instanceof HTMLElement) width = Math.round(dom.getBoundingClientRect().width)
    }
    widths.push(width)
  }
  return widths
}

/** The width of each column as the document has it; 0 where a column has none. */
export function columnWidths(table: PMNode): number[] {
  const map = TableMap.get(table)
  const widths: number[] = Array(map.width).fill(0)
  for (let row = 0; row < map.height; row++) {
    for (let col = 0; col < map.width; col++) {
      const cellPos = map.map[row * map.width + col]
      const cell = table.nodeAt(cellPos)
      if (!cell || widths[col]) continue
      const index = col - map.colCount(cellPos)
      const width = Number(cell.attrs.colwidth?.[index] ?? 0)
      if (width > 0) widths[col] = width
    }
  }
  return widths
}

/**
 * Sets the widths of all columns of the table at `tablePos` in one step: those in `set`, and every column without a
 * width so far gets the width it has on the page now, so that changing one column moves no other.
 */
export function setColumnWidths(view: EditorView, tablePos: number, set: Record<number, number>, { history = true } = {}): boolean {
  const table = view.state.doc.nodeAt(tablePos)
  if (!table || table.type.spec.tableRole !== 'table') return false
  const map = TableMap.get(table)
  const shown = shownWidths(view, table, tablePos)
  const widths = columnWidths(table).map((width, col) => {
    const wanted = set[col] ?? (width || shown[col] || 0)
    return wanted > 0 ? Math.max(COLUMN_MIN, Math.round(wanted)) : 0
  })
  const tr = view.state.tr
  const seen = new Set<number>()
  for (const cellPos of map.map) {
    if (seen.has(cellPos)) continue
    seen.add(cellPos)
    const cell = table.nodeAt(cellPos)!
    const first = map.colCount(cellPos)
    const colwidth = Array.from({ length: cell.attrs.colspan as number }, (_, i) => widths[first + i] ?? 0)
    const before = (cell.attrs.colwidth as number[] | null) ?? []
    if (colwidth.every((width, i) => width === (before[i] ?? 0))) continue
    tr.setNodeMarkup(tablePos + 1 + cellPos, null, { ...cell.attrs, colwidth: colwidth.some((width) => width > 0) ? colwidth : null })
  }
  if (!tr.docChanged) return false
  if (!history) tr.setMeta('addToHistory', false)
  view.dispatch(tr)
  return true
}

/** The table and the column of the cell at `cellPos` (a position before the cell); its last column if it spans. */
function columnOf(view: EditorView, cellPos: number): { tablePos: number; col: number } | null {
  const $cell = view.state.doc.resolve(cellPos)
  const table = $cell.node(-1)
  if (!table || table.type.spec.tableRole !== 'table' || !$cell.nodeAfter) return null
  const start = $cell.start(-1)
  const map = TableMap.get(table)
  return { tablePos: start - 1, col: map.colCount($cell.pos - start) + ($cell.nodeAfter.attrs.colspan as number) - 1 }
}

/** What the content of a column needs side by side, without wrapping; padding and border included. */
export function contentWidth(view: EditorView, tablePos: number, col: number): number {
  const table = view.state.doc.nodeAt(tablePos)
  if (!table) return 0
  const map = TableMap.get(table)
  // Measured beside the editor, never inside it: the editor would take a change of its own DOM for typing.
  const probe = document.createElement('div')
  probe.style.cssText = 'position:absolute;left:-10000px;top:0;visibility:hidden;white-space:nowrap;width:max-content'
  ;(view.dom.parentElement ?? document.body).appendChild(probe)
  let needed = 0
  try {
    for (let row = 0; row < map.height; row++) {
      const cellPos = map.map[row * map.width + col]
      const cell = table.nodeAt(cellPos)
      if (!cell || cell.attrs.colspan !== 1) continue
      const dom = view.nodeDOM(tablePos + 1 + cellPos)
      if (!(dom instanceof HTMLElement)) continue
      const style = getComputedStyle(dom)
      probe.style.font = style.font
      probe.replaceChildren(...Array.from(dom.childNodes, (child) => child.cloneNode(true)))
      probe.querySelectorAll<HTMLElement>('*').forEach((element) => {
        element.style.whiteSpace = 'nowrap'
        element.style.width = 'max-content'
      })
      const extra = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth)
      needed = Math.max(needed, Math.ceil(probe.getBoundingClientRect().width + (extra || 0) + 2))
    }
  } finally {
    probe.remove()
  }
  return Math.min(COLUMN_FIT_MAX, Math.max(COLUMN_MIN, needed))
}

/** Fits a column to its content (the double click on its edge, "Fit column to content" in the menu). */
export function fitColumn(view: EditorView, cellPos: number): boolean {
  const at = columnOf(view, cellPos)
  if (!at) return false
  return setColumnWidths(view, at.tablePos, { [at.col]: contentWidth(view, at.tablePos, at.col) })
}

/** The cell the selection stands in, as a position before it. */
function cellAtSelection(editor: Editor): number | null {
  const $cell = cellAround(editor.state.selection.$head)
  return $cell ? $cell.pos : null
}

function changeColumnWidth(editor: Editor, by: number): boolean {
  const cellPos = cellAtSelection(editor)
  const at = cellPos === null ? null : columnOf(editor.view, cellPos)
  if (!at) return false
  const table = editor.state.doc.nodeAt(at.tablePos)!
  const now = columnWidths(table)[at.col] || shownWidths(editor.view, table, at.tablePos)[at.col] || 120
  const done = setColumnWidths(editor.view, at.tablePos, { [at.col]: Math.max(COLUMN_MIN, now + by) })
  editor.view.focus()
  return done
}

function fitColumnAtSelection(editor: Editor): boolean {
  const cellPos = cellAtSelection(editor)
  const done = cellPos !== null && fitColumn(editor.view, cellPos)
  editor.view.focus()
  return done
}

/**
 * Dragging a column's edge (the resizing of the table extension) and double clicking it. Before a drag, every column
 * without a width gets the one it shows, outside the undo history (nothing one sees changes), so that the drag moves
 * this one edge and no other column; a double click fits the column to its content.
 */
export function columnWidthPlugin(): Plugin {
  return new Plugin({
    key: new PluginKey('noteColumnWidths'),
    props: {
      handleDOMEvents: {
        mousedown: (view, event) => {
          if (event.button !== 0 || !view.editable) return false
          const resizing = columnResizingPluginKey.getState(view.state)
          if (!resizing || resizing.activeHandle < 0) return false
          const at = columnOf(view, resizing.activeHandle)
          const table = at ? view.state.doc.nodeAt(at.tablePos) : null
          if (at && table && columnWidths(table).some((width) => !width)) setColumnWidths(view, at.tablePos, {}, { history: false })
          return false
        },
        dblclick: (view, event) => {
          if (!view.editable) return false
          const resizing = columnResizingPluginKey.getState(view.state)
          if (!resizing || resizing.activeHandle < 0) return false
          event.preventDefault()
          return fitColumn(view, resizing.activeHandle)
        },
      },
    },
  })
}
