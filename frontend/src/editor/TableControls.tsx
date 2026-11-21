/**
 * Tables without knowing anything beforehand (NOTES-3 AC-5): while the cursor stands in a table, a small button at
 * its top right opens the table's menu (rows and columns in, out, up and down, header row, delete the table), and a
 * quiet "+" along its right and its bottom edge adds a column or a row. A right click in a cell opens the same menu
 * at the pointer. The menu is the app's one menu, so the table's own box (which scrolls sideways when the table is
 * wide) never cuts it off.
 */
import type { Editor } from '@tiptap/core'
import { useEditorState } from '@tiptap/react'
import { Plus, Table2 } from 'lucide-react'
import { Fragment, useEffect, useLayoutEffect, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'

import { Menu, type MenuAnchor } from '../components/Menu'
import { TABLE_MENU, tableActions, tableAtSelection, type TableAction } from './table'

type Box = { top: number; left: number; width: number; height: number }

export function TableMenuItems({ editor, onDone }: { editor: Editor; onDone: () => void }) {
  const { t } = useTranslation()
  const actions = tableActions(editor)
  const header = editor.isActive('tableHeader') || Boolean(tableAtSelection(editor)?.querySelector('tr:first-child th'))
  return (
    <>
      {TABLE_MENU.map((action, index) =>
        action === null ? (
          <div key={`line-${index}`} role="separator" className="my-1 border-t border-ink-700" />
        ) : (
          <button
            key={action}
            type="button"
            role={action === 'toggleHeaderRow' ? 'menuitemcheckbox' : 'menuitem'}
            aria-checked={action === 'toggleHeaderRow' ? header : undefined}
            className={'nn-menu-item ' + (action.startsWith('delete') ? 'text-bad-500 hover:text-bad-500' : '')}
            data-testid={`table-${action}`}
            onClick={() => {
              onDone()
              actions[action as TableAction]()
            }}
          >
            {t(`editor.table.${action}`)}
          </button>
        ),
      )}
    </>
  )
}

export function TableControls({ editor, frame }: { editor: Editor; frame: RefObject<HTMLElement | null> }) {
  const { t } = useTranslation()
  const [box, setBox] = useState<Box | null>(null)
  const [menu, setMenu] = useState<MenuAnchor | null>(null)
  const inTable = useEditorState({ editor, selector: ({ editor: current }) => (current.isEditable && current.isActive('table') ? current.state.selection.from : -1) })

  // Where the table stands inside the sheet; again after every change, scroll and new size.
  useLayoutEffect(() => {
    const place = () => {
      const table = inTable !== null && inTable >= 0 ? tableAtSelection(editor) : null
      const outer = frame.current
      if (!table || !outer) return setBox(null)
      const shown = (table.closest('.tableWrapper') as HTMLElement | null) ?? table
      const a = shown.getBoundingClientRect()
      const b = outer.getBoundingClientRect()
      const width = Math.min(a.width, table.getBoundingClientRect().width)
      setBox({ top: a.top - b.top, left: a.left - b.left, width, height: a.height })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [editor, frame, inTable])

  // A right click in a cell: the menu at the pointer, the cursor in that cell.
  useEffect(() => {
    const dom = editor.view.dom
    const context = (event: MouseEvent) => {
      const cell = (event.target as Element | null)?.closest?.('td, th')
      if (!cell || !editor.isEditable) return
      event.preventDefault()
      // The cursor into that cell (where in it does not matter for the menu).
      try {
        editor.chain().focus().setTextSelection(editor.view.posAtDOM(cell, 0) + 1).run()
      } catch {
        // A cell the editor cannot place: the menu works on the cell the cursor is in.
      }
      setMenu({ x: event.clientX, y: event.clientY })
    }
    dom.addEventListener('contextmenu', context)
    return () => dom.removeEventListener('contextmenu', context)
  }, [editor])

  const actions = tableActions(editor)
  const add = (what: 'row' | 'column') => {
    // At the end: the last row or column gets the cursor first.
    const table = tableAtSelection(editor)
    const last = what === 'row' ? table?.querySelector('tr:last-child > :first-child') : table?.querySelector('tr:first-child > :last-child')
    if (last) {
      const at = editor.view.posAtDOM(last, 0)
      editor.chain().focus().setTextSelection(at + 1).run()
    }
    if (what === 'row') actions.addRowAfter()
    else actions.addColumnAfter()
  }

  return (
    <>
      {box && (
        <Fragment>
          <button
            type="button"
            aria-label={t('editor.table.label')}
            title={t('editor.table.label')}
            aria-haspopup="menu"
            aria-expanded={menu !== null}
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => setMenu(menu ? null : event.currentTarget)}
            className="absolute z-10 flex h-7 w-7 items-center justify-center rounded-md border border-ink-700 bg-ink-850 text-mist-300 shadow-sm hover:text-mist-100"
            style={{ top: box.top - 32, left: box.left + box.width - 28 }}
            data-testid="table-menu-button"
          >
            <Table2 className="h-4 w-4" aria-hidden />
          </button>
          <button
            type="button"
            aria-label={t('editor.table.appendColumn')}
            title={t('editor.table.appendColumn')}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => add('column')}
            className="absolute z-10 flex w-4 items-center justify-center rounded-md text-mist-500 opacity-60 hover:bg-ink-800 hover:text-mist-100 hover:opacity-100"
            style={{ top: box.top, left: box.left + box.width + 2, height: box.height }}
            data-testid="table-add-column"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
          </button>
          <button
            type="button"
            aria-label={t('editor.table.appendRow')}
            title={t('editor.table.appendRow')}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => add('row')}
            className="absolute z-10 flex h-4 items-center justify-center rounded-md text-mist-500 opacity-60 hover:bg-ink-800 hover:text-mist-100 hover:opacity-100"
            style={{ top: box.top + box.height + 2, left: box.left, width: box.width }}
            data-testid="table-add-row"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
          </button>
        </Fragment>
      )}
      {menu && (
        <Menu anchor={menu} onClose={() => setMenu(null)} label={t('editor.table.label')} align={menu instanceof HTMLElement ? 'end' : 'start'} testId="table-menu">
          <TableMenuItems editor={editor} onDone={() => setMenu(null)} />
        </Menu>
      )}
    </>
  )
}
