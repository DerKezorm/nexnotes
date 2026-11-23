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
  ChevronsRight,
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
import { Fragment, useContext, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { Menu } from '../components/Menu'
import { HIGHLIGHT_COLORS } from './extensions'
import { TableMenuItems } from './TableControls'
import { OutlineToggleContext, useOutlineShown } from './outlineData'
import { groupWidth, TOOL_GROUPS, TOOL_WIDTH, toolRows } from './toolbarRows'
import { TEXT_WIDTHS, useTextWidth } from './textWidth'

/** The tools that go into "More" first when the row is short: the ones used least. */
const HIDE_ORDER = ['outline', 'width', 'divider', 'outdent', 'indent', 'code', 'quote', 'strike', 'underline', 'highlight', 'table', 'link', 'redo', 'undo', 'task', 'ordered', 'bullet', 'italic', 'bold']

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

/** A small menu of a tool (highlighter, table, width): the shared menu, beside the tool's button. */
function Popover({ label, onClose, children, anchor, end = false }: { label: string; onClose: () => void; children: ReactNode; anchor: HTMLElement | null; end?: boolean }) {
  if (!anchor) return null
  return (
    <Menu anchor={anchor} onClose={onClose} label={label} align={end ? 'end' : 'start'}>
      {children}
    </Menu>
  )
}

type ToolbarProps = {
  editor: Editor
  onLink: () => void
  compact?: boolean
  /** `text`: only the tools that work on the text, for the one bar over two notes side by side (NOTES-8, 21.11.2026);
   * the text width and the outline then stand in each sheet's own bar (`NoteViewTools`). */
  part?: 'all' | 'text'
  /** The bar's name for a screen reader; over two notes it names the note it works on. */
  label?: string
  /** The note is one to read only: every tool is shown but cannot be used. */
  locked?: boolean
}

export function Toolbar({ editor, onLink, compact = false, part = 'all', label, locked = false }: ToolbarProps) {
  const { t } = useTranslation()
  const state = useEditorState({ editor, selector: ({ editor: current }) => readState(current) })
  const bar = useRef<HTMLDivElement>(null)
  const [focusAt, setFocusAt] = useState(0)
  const [menu, setMenu] = useState<'highlight' | 'table' | 'width' | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const moreButton = useRef<HTMLButtonElement>(null)
  const [room, setRoom] = useState(0)
  useEffect(() => {
    const element = bar.current
    if (!element || compact || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setRoom(Math.floor(entry.contentRect.width)))
    observer.observe(element)
    return () => observer.disconnect()
  }, [compact])
  const [textWidth, setTextWidth] = useTextWidth()
  // The note's side says what the outline button does (a column or a panel); alone (no note around it) the setting.
  const outlineToggle = useContext(OutlineToggleContext)
  const [outlineSetting, setOutlineSetting] = useOutlineShown()
  const outlineShown = outlineToggle ? outlineToggle.shown : outlineSetting
  const flipOutline = outlineToggle ? outlineToggle.toggle : () => setOutlineSetting(!outlineSetting)
  const chain = () => editor.chain().focus()
  const toolButton = (key: string) => bar.current?.querySelector<HTMLElement>(`[data-testid="tool-${key}"]`) ?? null

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
    { key: 'link', label: t('editor.tools.link'), shortcut: `${MOD}+${ALT}+K`, icon: LinkIcon, active: state.link, run: onLink },
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
  else if (part === 'all')
    buttons.push(
      { key: 'width', label: t('editor.tools.width'), icon: MoveHorizontal, menu: true, active: textWidth !== 'narrow', run: () => setMenu(menu === 'width' ? null : 'width') },
      // The outline (AC-15): beside the text where there is room, otherwise a panel over its right edge. Pressed means
      // it is on the screen (third review: pressed with nothing to see read as a dead button).
      { key: 'outline', label: t('editor.tools.outline'), icon: PanelRight, active: outlineShown, run: flipOutline },
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
  // The groups of tools in one row or two, broken only between groups (second review); only what not even two
  // rows hold goes into "More", whole groups from the end. Not even one group fits (a very narrow side): one row, and
  // the tools used least go into "More" first, the text style too. On a phone one row above the keyboard that scrolls
  // sideways. Worked out from the bar's width alone, so typing never changes it. Unknown width (no layout yet): one row.
  const present = new Set(['style', ...buttons.map((button) => button.key)])
  const groups = TOOL_GROUPS.map((group) => group.filter((key) => present.has(key))).filter((group) => group.length > 0)
  const layout = compact ? null : toolRows(groups.map(groupWidth), room)
  const rows = layout && layout.rows.length > 0 ? layout.rows : null
  const restList = rows && layout ? layout.rest.flatMap((index) => groups[index]) : []
  // Of what two rows of whole groups do not hold, the first tools still stand at the end of the second row.
  const extraKeys = restList.slice(0, layout?.extra ?? 0)
  const restKeys = new Set(restList.slice(extraKeys.length))
  const narrow = !compact && !rows && room > 0
  const capacity = compact || rows || !room ? buttons.length : Math.max(0, Math.floor(room / TOOL_WIDTH))
  const overflow = capacity >= buttons.length ? 0 : buttons.length - Math.max(0, capacity - 1)
  const away = rows ? restKeys : new Set(HIDE_ORDER.filter((key) => buttons.some((button) => button.key === key)).slice(0, overflow))
  const visible = buttons.filter((button) => !away.has(button.key))
  const hidden = buttons.filter((button) => away.has(button.key))
  const anchorOf = (key: string) => toolButton(key) ?? moreButton.current
  // Very narrow (a side of two at a small window): the text style goes into "More" too.
  const styleAway = narrow
  const styles = [
    ['h1', () => chain().setHeading({ level: 1 }).run()],
    ['h2', () => chain().setHeading({ level: 2 }).run()],
    ['h3', () => chain().setHeading({ level: 3 }).run()],
    ['p', () => chain().setParagraph().run()],
  ] as const
  const line = (key: string) => <span key={key} aria-hidden className="mx-1.5 h-[22px] w-px shrink-0 bg-ink-700" />
  const styleField = (
    <Fragment key="style">
      <label className="sr-only" htmlFor="nn-text-style">
        {t('editor.tools.style')}
      </label>
      <span className="relative flex shrink-0">
        <select
          id="nn-text-style"
          data-tool
          tabIndex={focusAt === 0 ? 0 : -1}
          onFocus={() => setFocusAt(0)}
          disabled={locked || !state.editable}
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
    </Fragment>
  )
  const tool = (button: ButtonSpec, position: number) => {
    const Icon = button.icon
    const title = button.shortcut ? `${button.label} (${button.shortcut})` : button.label
    return (
      <span key={button.key} className="relative flex shrink-0">
        <button
          type="button"
          data-tool
          data-testid={`tool-${button.key}`}
          data-outline-toggle={button.key === 'outline' ? outlineToggle?.id : undefined}
          tabIndex={focusAt === position ? 0 : -1}
          onFocus={() => setFocusAt(position)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={button.run}
          disabled={locked || button.disabled || (!state.editable && !['undo', 'redo', 'keyboard', 'width', 'outline'].includes(button.key))}
          aria-label={button.label}
          aria-pressed={button.menu ? undefined : button.active}
          aria-haspopup={button.menu ? 'menu' : undefined}
          aria-expanded={button.menu ? menu === button.key : undefined}
          title={title}
          className={`${size} flex items-center justify-center rounded-lg transition-colors disabled:opacity-35 ${button.active ? 'nn-chosen' : 'text-mist-300 not-disabled:hover:bg-ink-800 not-disabled:hover:text-mist-100'}`}
        >
          <Icon className="h-4 w-4" strokeWidth={button.key === 'bold' ? 2.6 : 2} aria-hidden />
        </button>
      </span>
    )
  }
  // "More": after the last tool on show, its place for the keys after every tool.
  const morePlace = rows ? buttons.length + 1 : visible.length + 1
  const moreTool = (
    <span key="more" className="relative flex shrink-0">
      <button
        ref={moreButton}
        type="button"
        data-tool
        data-testid="tool-more"
        tabIndex={focusAt === morePlace ? 0 : -1}
        onFocus={() => setFocusAt(morePlace)}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setMoreOpen(!moreOpen)}
        aria-label={t('editor.tools.more')}
        aria-haspopup="menu"
        aria-expanded={moreOpen}
        title={t('editor.tools.more')}
        className={`${size} flex items-center justify-center rounded-lg text-mist-300 hover:bg-ink-800 hover:text-mist-100`}
      >
        <ChevronsRight className="h-4 w-4" aria-hidden />
      </button>
    </span>
  )
  // A tool's place for the keys is its place in the order of the groups (EC-11): the arrows run over both rows.
  const placeOf = (key: string) => buttons.findIndex((button) => button.key === key) + 1
  const byKey = new Map(buttons.map((button) => [button.key, button]))
  return (
    <div
      ref={bar}
      role="toolbar"
      aria-label={label ?? t('editor.tools.label')}
      aria-disabled={locked || undefined}
      onKeyDown={move}
      data-testid="toolbar"
      data-rows={rows ? rows.length : 1}
      className={
        compact
          ? 'nn-scroll flex items-center gap-0.5 overflow-x-auto border-t border-ink-700 bg-ink-850 px-2 py-1.5'
          : rows
            ? 'flex w-full min-w-0 flex-col gap-1 overflow-hidden'
            : 'flex min-w-0 flex-nowrap items-center gap-1 overflow-hidden'
      }
    >
      {rows &&
        rows.map((row, index) => (
          <div key={index} className="flex min-w-0 flex-nowrap items-center gap-1" data-testid="toolbar-row">
            {row.flatMap((groupIndex, at) => [
              ...(at > 0 ? [line(`line-${groupIndex}`)] : []),
              ...groups[groupIndex].map((key) => (key === 'style' ? styleField : tool(byKey.get(key)!, placeOf(key)))),
            ])}
            {index === rows.length - 1 && hidden.length > 0 && [
              ...(row.length > 0 ? [line('line-more')] : []),
              ...extraKeys.map((key) => tool(byKey.get(key)!, placeOf(key))),
              moreTool,
            ]}
          </div>
        ))}
      {!rows && !styleAway && styleField}
      {!rows && !compact && !styleAway && line('line-style')}
      {!rows && visible.map((button, index) => tool(button, index + 1))}
      {!rows && (hidden.length > 0 || styleAway) && moreTool}
      {moreOpen && moreButton.current && (
        <Menu anchor={moreButton.current} onClose={() => setMoreOpen(false)} label={t('editor.tools.more')} testId="tool-more-menu">
          {styleAway &&
            styles.map(([value, run]) => (
              <button
                key={value}
                type="button"
                role="menuitemradio"
                aria-checked={state.style === value}
                className="nn-menu-item"
                data-testid={`more-style-${value}`}
                disabled={locked || !state.editable}
                onClick={() => {
                  setMoreOpen(false)
                  run()
                }}
              >
                <span aria-hidden className="w-4 text-accent-400">{state.style === value ? '✓' : ''}</span>
                {t(`editor.style.${value}`)}
              </button>
            ))}
          {hidden.map((button) => {
            const Icon = button.icon
            return (
              <button
                key={button.key}
                type="button"
                role="menuitem"
                className="nn-menu-item"
                data-testid={`more-${button.key}`}
                data-outline-toggle={button.key === 'outline' ? outlineToggle?.id : undefined}
                disabled={locked || button.disabled || (!state.editable && !['undo', 'redo', 'width', 'outline'].includes(button.key))}
                onClick={() => {
                  setMoreOpen(false)
                  button.run()
                }}
              >
                <Icon className="h-4 w-4" aria-hidden />
                <span className="flex-1">{button.label}</span>
                {button.shortcut && <span className="text-[11px] text-mist-500">{button.shortcut}</span>}
              </button>
            )
          })}
        </Menu>
      )}
      {menu === 'highlight' && (
        <Popover label={t('editor.tools.highlight')} onClose={() => setMenu(null)} anchor={anchorOf('highlight')}>
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
      {menu === 'width' && (
        <Popover label={t('editor.tools.width')} onClose={() => setMenu(null)} anchor={anchorOf('width')} end>
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
      {menu === 'table' && (
        <Popover label={t('editor.table.label')} onClose={() => setMenu(null)} anchor={anchorOf('table')}>
          <TableMenuItems editor={editor} onDone={() => setMenu(null)} />
        </Popover>
      )}
    </div>
  )
}
