/**
 * The toolbar of a note (NOTES-3 AC-3): text style, bold, italic, underline, strike, highlighter, bullets, numbers,
 * checklist, table, link, quote, code, indenting, divider, undo and redo. One stop for Tab, the arrow keys move inside
 * (EC-11); Alt+F10 in the text comes here. On a phone it sits above the keyboard and scrolls sideways (drawing
 * "Handy-Editor").
 */
import type { Editor } from '@tiptap/core'
import { useEditorState } from '@tiptap/react'
import {
  Bold,
  ChevronDown,
  Code,
  Highlighter,
  IndentDecrease,
  IndentIncrease,
  Italic,
  Keyboard,
  Link as LinkIcon,
  List,
  ListChecks,
  ListOrdered,
  MoveHorizontal,
  PanelRight,
  Redo2,
  SeparatorHorizontal,
  Strikethrough,
  Table as TableIcon,
  TextQuote,
  Underline,
  Undo2,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { HIGHLIGHT_COLORS } from './extensions'
import { tableActions } from './table'
import { useOutlineShown } from './outlineData'
import { TEXT_WIDTHS, useTextWidth } from './textWidth'

const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'
const ALT = MOD === '⌘' ? '⌥' : 'Alt'

/** What the toolbar shows as chosen, read once per change of the editor. */
function readState(editor: Editor) {
  return {
    style: editor.isActive('heading', { level: 1 }) ? 'h1' : editor.isActive('heading', { level: 2 }) ? 'h2' : editor.isActive('heading', { level: 3 }) ? 'h3' : 'p',
    bold: editor.isActive('bold'),
    italic: editor.isActive('italic'),
    underline: editor.isActive('underline'),
    strike: editor.isActive('strike'),
    highlight: editor.isActive('highlight'),
    bullet: editor.isActive('bulletList'),
    ordered: editor.isActive('orderedList'),
    task: editor.isActive('taskList'),
    table: editor.isActive('table'),
    link: editor.isActive('link'),
    quote: editor.isActive('blockquote'),
    code: editor.isActive('code') || editor.isActive('codeBlock'),
    canUndo: editor.can().undo(),
    canRedo: editor.can().redo(),
    canSink: editor.can().sinkListItem('listItem') || editor.can().sinkListItem('taskItem'),
    canLift: editor.can().liftListItem('listItem') || editor.can().liftListItem('taskItem'),
    editable: editor.isEditable,
  }
}

type ButtonSpec = {
  key: string
  label: string
  shortcut?: string
  icon: LucideIcon
  active?: boolean
  disabled?: boolean
  run: () => void
  /** Opens a small menu instead of acting. */
  menu?: boolean
}

function Popover({ label, onClose, children, end = false }: { label: string; onClose: () => void; children: ReactNode; end?: boolean }) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('button')?.focus()
    const away = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) onClose()
    }
    window.addEventListener('pointerdown', away, true)
    return () => window.removeEventListener('pointerdown', away, true)
  }, [onClose])
  return (
    <div
      ref={box}
      role="menu"
      aria-label={label}
      className={'nn-menu absolute top-full mt-1 ' + (end ? 'right-0' : 'left-0')}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onClose()
          return
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          const items = Array.from(box.current?.querySelectorAll<HTMLElement>('button') ?? [])
          const at = items.indexOf(document.activeElement as HTMLElement)
          items[(at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
        }
      }}
    >
      {children}
    </div>
  )
}

export function Toolbar({ editor, onLink, compact = false }: { editor: Editor; onLink: () => void; compact?: boolean }) {
  const { t } = useTranslation()
  const state = useEditorState({ editor, selector: ({ editor: current }) => readState(current) })
  const bar = useRef<HTMLDivElement>(null)
  const [focusAt, setFocusAt] = useState(0)
  const [menu, setMenu] = useState<'highlight' | 'table' | 'width' | null>(null)
  const [textWidth, setTextWidth] = useTextWidth()
  const [outline, setOutline] = useOutlineShown()
  const chain = () => editor.chain().focus()

  // Alt+F10 in the text moves to the toolbar (EC-11).
  useEffect(() => {
    const dom = editor.view.dom
    const key = (event: KeyboardEvent) => {
      if (event.altKey && event.key === 'F10') {
        event.preventDefault()
        bar.current?.querySelector<HTMLElement>('[data-tool][tabindex="0"]')?.focus()
      }
    }
    dom.addEventListener('keydown', key)
    return () => dom.removeEventListener('keydown', key)
  }, [editor])

  if (!state) return null
  const table = tableActions(editor)
  const sinkOrLift = (sink: boolean) => {
    const kind = editor.isActive('taskItem') ? 'taskItem' : 'listItem'
    return sink ? chain().sinkListItem(kind).run() : chain().liftListItem(kind).run()
  }

  const buttons: ButtonSpec[] = [
    { key: 'bold', label: t('editor.tools.bold'), shortcut: `${MOD}+B`, icon: Bold, active: state.bold, run: () => chain().toggleBold().run() },
    { key: 'italic', label: t('editor.tools.italic'), shortcut: `${MOD}+I`, icon: Italic, active: state.italic, run: () => chain().toggleItalic().run() },
    { key: 'underline', label: t('editor.tools.underline'), shortcut: `${MOD}+U`, icon: Underline, active: state.underline, run: () => chain().toggleUnderline().run() },
    { key: 'strike', label: t('editor.tools.strike'), shortcut: `${MOD}+Shift+S`, icon: Strikethrough, active: state.strike, run: () => chain().toggleStrike().run() },
    { key: 'highlight', label: t('editor.tools.highlight'), shortcut: `${MOD}+Shift+H`, icon: Highlighter, active: state.highlight, menu: true, run: () => setMenu(menu === 'highlight' ? null : 'highlight') },
    { key: 'bullet', label: t('editor.tools.bullet'), shortcut: `${MOD}+Shift+8`, icon: List, active: state.bullet, run: () => chain().toggleBulletList().run() },
    { key: 'ordered', label: t('editor.tools.ordered'), shortcut: `${MOD}+Shift+7`, icon: ListOrdered, active: state.ordered, run: () => chain().toggleOrderedList().run() },
    { key: 'task', label: t('editor.tools.task'), shortcut: `${MOD}+Shift+9`, icon: ListChecks, active: state.task, run: () => chain().toggleTaskList().run() },
    {
      key: 'table',
      label: t('editor.tools.table'),
      shortcut: `${MOD}+${ALT}+T`,
      icon: TableIcon,
      active: state.table,
      menu: state.table,
      run: () => (state.table ? setMenu(menu === 'table' ? null : 'table') : chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()),
    },
    { key: 'link', label: t('editor.tools.link'), shortcut: `${MOD}+K`, icon: LinkIcon, active: state.link, run: onLink },
    { key: 'quote', label: t('editor.tools.quote'), shortcut: `${MOD}+Shift+B`, icon: TextQuote, active: state.quote, run: () => chain().toggleBlockquote().run() },
    {
      key: 'code',
      label: t('editor.tools.code'),
      shortcut: `${MOD}+E · ${MOD}+${ALT}+C`,
      icon: Code,
      active: state.code,
      // With a selection inside a line: code in the text; otherwise a code block.
      run: () => {
        const { from, to, $from, $to } = editor.state.selection
        if (from !== to && $from.sameParent($to) && !editor.isActive('codeBlock')) chain().toggleCode().run()
        else chain().toggleCodeBlock().run()
      },
    },
    { key: 'indent', label: t('editor.tools.indent'), shortcut: 'Tab', icon: IndentIncrease, disabled: !state.canSink, run: () => sinkOrLift(true) },
    { key: 'outdent', label: t('editor.tools.outdent'), shortcut: 'Shift+Tab', icon: IndentDecrease, disabled: !state.canLift, run: () => sinkOrLift(false) },
    { key: 'divider', label: t('editor.tools.divider'), shortcut: '---', icon: SeparatorHorizontal, run: () => chain().setHorizontalRule().run() },
    { key: 'undo', label: t('editor.tools.undo'), shortcut: `${MOD}+Z`, icon: Undo2, disabled: !state.canUndo, run: () => chain().undo().run() },
    { key: 'redo', label: t('editor.tools.redo'), shortcut: `${MOD}+Shift+Z`, icon: Redo2, disabled: !state.canRedo, run: () => chain().redo().run() },
  ]
  if (compact) buttons.push({ key: 'keyboard', label: t('editor.tools.closeKeyboard'), icon: Keyboard, run: () => editor.commands.blur() })
  // The width of the text (AC-14): a matter of the screen, so not on a phone, and it works on a note one only reads.
  else
    buttons.push(
      { key: 'width', label: t('editor.tools.width'), icon: MoveHorizontal, menu: true, active: textWidth !== 'narrow', run: () => setMenu(menu === 'width' ? null : 'width') },
      // The outline beside the text (AC-15): it shows only where there is room, the button says whether it may.
      { key: 'outline', label: t('editor.tools.outline'), icon: PanelRight, active: outline, run: () => setOutline(!outline) },
    )

  const move = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('[role="menu"]')) return
    if (event.key === 'Escape') {
      event.preventDefault()
      editor.commands.focus()
      return
    }
    // Disabled tools are skipped; they cannot take the focus.
    const tools = Array.from(bar.current?.querySelectorAll<HTMLElement>('[data-tool]:not(:disabled)') ?? [])
    const at = tools.indexOf(document.activeElement as HTMLElement)
    if (at < 0) return
    const steps: Record<string, number> = { ArrowRight: (at + 1) % tools.length, ArrowLeft: (at - 1 + tools.length) % tools.length, Home: 0, End: tools.length - 1 }
    const next = steps[event.key]
    if (next === undefined) return
    event.preventDefault()
    const all = Array.from(bar.current?.querySelectorAll<HTMLElement>('[data-tool]') ?? [])
    setFocusAt(all.indexOf(tools[next]))
    tools[next]?.focus()
  }

  const size = compact ? 'h-11 w-11' : 'h-[34px] w-[34px]'
  return (
    <div
      ref={bar}
      role="toolbar"
      aria-label={t('editor.tools.label')}
      onKeyDown={move}
      data-testid="toolbar"
      className={compact ? 'nn-scroll flex items-center gap-0.5 overflow-x-auto border-t border-ink-700 bg-ink-850 px-2 py-1.5' : 'flex flex-wrap items-center gap-1'}
    >
      <label className="sr-only" htmlFor="nn-text-style">
        {t('editor.tools.style')}
      </label>
      <span className="relative flex shrink-0">
        <select
          id="nn-text-style"
          data-tool
          tabIndex={focusAt === 0 ? 0 : -1}
          onFocus={() => setFocusAt(0)}
          disabled={!state.editable}
          value={state.style}
          onKeyDown={(event) => {
            // The arrows choose inside the list; only sideways leaves it.
            if (event.key === 'ArrowUp' || event.key === 'ArrowDown') event.stopPropagation()
          }}
          onChange={(event) => {
            const value = event.target.value
            if (value === 'p') chain().setParagraph().run()
            else chain().setHeading({ level: Number(value.slice(1)) as 1 | 2 | 3 }).run()
          }}
          className={'appearance-none rounded-lg border border-ink-700 bg-transparent pr-7 pl-2.5 text-[13px] text-mist-100 ' + (compact ? 'h-11' : 'h-[34px]')}
          title={`${t('editor.tools.style')} (${MOD}+${ALT}+1 / 2 / 0)`}
        >
          <option value="h1">{t('editor.style.h1')}</option>
          <option value="h2">{t('editor.style.h2')}</option>
          <option value="h3">{t('editor.style.h3')}</option>
          <option value="p">{t('editor.style.p')}</option>
        </select>
        <ChevronDown aria-hidden className="pointer-events-none absolute top-1/2 right-2 h-3 w-3 -translate-y-1/2 text-mist-500" />
      </span>
      {!compact && <span aria-hidden className="mx-1.5 h-[22px] w-px bg-ink-700" />}
      {buttons.map((button, index) => {
        const Icon = button.icon
        const position = index + 1
        const title = button.shortcut ? `${button.label} (${button.shortcut})` : button.label
        return (
          <span key={button.key} className="relative flex shrink-0">
            <button
              type="button"
              data-tool
              data-testid={`tool-${button.key}`}
              tabIndex={focusAt === position ? 0 : -1}
              onFocus={() => setFocusAt(position)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={button.run}
              disabled={button.disabled || (!state.editable && !['undo', 'redo', 'keyboard', 'width', 'outline'].includes(button.key))}
              aria-label={button.label}
              aria-pressed={button.menu ? undefined : button.active}
              aria-haspopup={button.menu ? 'menu' : undefined}
              aria-expanded={button.menu ? menu === button.key : undefined}
              title={title}
              className={`${size} flex items-center justify-center rounded-lg transition-colors disabled:opacity-35 ${button.active ? 'nn-chosen' : 'text-mist-300 hover:bg-ink-800 hover:text-mist-100'}`}
            >
              <Icon className="h-4 w-4" strokeWidth={button.key === 'bold' ? 2.6 : 2} aria-hidden />
            </button>
            {button.key === 'highlight' && menu === 'highlight' && (
              <Popover label={t('editor.tools.highlight')} onClose={() => setMenu(null)}>
                {HIGHLIGHT_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    role="menuitem"
                    className="nn-menu-item"
                    data-testid={`highlight-${color}`}
                    onClick={() => {
                      setMenu(null)
                      chain().setHighlight({ color }).run()
                    }}
                  >
                    <span aria-hidden className="nn-swatch" data-color={color} />
                    {t(`editor.colors.${color}`)}
                  </button>
                ))}
                <button
                  type="button"
                  role="menuitem"
                  className="nn-menu-item"
                  onClick={() => {
                    setMenu(null)
                    chain().unsetHighlight().run()
                  }}
                >
                  <span aria-hidden className="nn-swatch nn-swatch-none" />
                  {t('editor.colors.none')}
                </button>
              </Popover>
            )}
            {button.key === 'width' && menu === 'width' && (
              <Popover label={t('editor.tools.width')} onClose={() => setMenu(null)} end>
                {TEXT_WIDTHS.map((width) => (
                  <button
                    key={width}
                    type="button"
                    role="menuitemradio"
                    aria-checked={textWidth === width}
                    className="nn-menu-item"
                    data-testid={`width-${width}`}
                    onClick={() => {
                      setMenu(null)
                      setTextWidth(width)
                    }}
                  >
                    <span aria-hidden className="w-4 text-accent-400">{textWidth === width ? '✓' : ''}</span>
                    {t(`editor.width.${width}`)}
                  </button>
                ))}
              </Popover>
            )}
            {button.key === 'table' && menu === 'table' && (
              <Popover label={t('editor.table.label')} onClose={() => setMenu(null)}>
                {(
                  [
                    ['addRowBefore', 'editor.table.addRowBefore'],
                    ['addRowAfter', 'editor.table.addRowAfter'],
                    ['rowUp', 'editor.table.rowUp'],
                    ['rowDown', 'editor.table.rowDown'],
                    ['deleteRow', 'editor.table.deleteRow'],
                    ['addColumnBefore', 'editor.table.addColumnBefore'],
                    ['addColumnAfter', 'editor.table.addColumnAfter'],
                    ['columnLeft', 'editor.table.columnLeft'],
                    ['columnRight', 'editor.table.columnRight'],
                    ['deleteColumn', 'editor.table.deleteColumn'],
                    ['deleteTable', 'editor.table.deleteTable'],
                  ] as const
                ).map(([action, label]) => (
                  <button
                    key={action}
                    type="button"
                    role="menuitem"
                    className="nn-menu-item"
                    data-testid={`table-${action}`}
                    onClick={() => {
                      setMenu(null)
                      table[action]()
                    }}
                  >
                    {t(label)}
                  </button>
                ))}
              </Popover>
            )}
          </span>
        )
      })}
    </div>
  )
}
