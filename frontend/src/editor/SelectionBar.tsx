/**
 * The small bar at selected text (NOTES-3 AC-20, third review): the most used formats right above the selection,
 * in the order and with the symbols of the toolbar: bold, italic, underline, strike, the highlighter (a click gives
 * honey, the arrow beside it the other colours), link, code, the text style, clearing the formats.
 *
 * Only for one's own selection of real text (never an empty one, never in a code block, never for someone who only
 * reads) and only on a desk with a mouse or touchpad: on a touch screen the system's own menu stands at a selection and
 * the tools sit above the keyboard. It keeps clear of the edges (above the selection, below it at the top of the side,
 * never cut off), goes away on typing, Escape or a click beside it, and a click on it keeps the selection. Alt+F10
 * in the text comes here while it shows; the arrows move inside, Escape goes back to the text.
 */
import type { Editor } from '@tiptap/core'
import { PluginKey, TextSelection, type Selection } from '@tiptap/pm/state'
import { useEditorState } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import { Bold, ChevronDown, Code, Highlighter, Italic, Link as LinkIcon, RemoveFormatting, Strikethrough, Underline, type LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'

import { HIGHLIGHT_COLORS } from './extensions'

const SELECTION_BAR = new PluginKey('selectionBar')

const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'
const ALT = MOD === '⌘' ? '⌥' : 'Alt'

/** A screen with nothing that hovers (a phone, a tablet without a mouse): the bar stays away there. */
function touchOnly(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(any-hover: none)').matches
}

function readState(editor: Editor) {
  return {
    bold: editor.isActive('bold'),
    italic: editor.isActive('italic'),
    underline: editor.isActive('underline'),
    strike: editor.isActive('strike'),
    highlight: editor.isActive('highlight'),
    link: editor.isActive('link'),
    code: editor.isActive('code'),
    style: editor.isActive('heading', { level: 1 }) ? 'h1' : editor.isActive('heading', { level: 2 }) ? 'h2' : 'p',
  }
}

type Tool = { key: string; label: string; shortcut?: string; icon: LucideIcon; active?: boolean; run: () => void }

export function SelectionBar({ editor, onLink, headHeight = 0 }: { editor: Editor; onLink: () => void; headHeight?: number }) {
  const { t } = useTranslation()
  const state = useEditorState({ editor, selector: ({ editor: current }) => readState(current) })
  const bar = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState<'highlight' | 'style' | null>(null)
  const [focusAt, setFocusAt] = useState(0)
  // Escape sends the bar away for this selection; a new selection brings it back.
  const dismissed = useRef<Selection | null>(null)
  // A selection made with a finger (a touch screen with a mouse too): the system's menu stands there.
  const byTouch = useRef(false)

  const shouldShow = useCallback(
    ({ editor: current, state: now, from, to }: { editor: Editor; state: Editor['state']; from: number; to: number }) => {
      const selection = now.selection
      if (!current.isEditable) return false
      // Real text only: no empty selection, no node (a picture, a sketch), no run of empty lines.
      if (!(selection instanceof TextSelection) || !now.doc.textBetween(from, to).trim()) return false
      if (current.isActive('codeBlock')) return false
      if (touchOnly() || byTouch.current) return false
      if (dismissed.current && dismissed.current.eq(selection)) return false
      const inside = bar.current?.contains(document.activeElement) ?? false
      return current.view.hasFocus() || inside
    },
    [],
  )

  const hide = useCallback(() => {
    setOpen(null)
    dismissed.current = editor.state.selection
    if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(SELECTION_BAR, 'hide'))
  }, [editor])

  useEffect(() => {
    const dom = editor.view.dom
    const pointer = (event: PointerEvent) => {
      byTouch.current = event.pointerType === 'touch'
      dismissed.current = null
    }
    const keys = (event: KeyboardEvent) => {
      // Keys of the window itself (the app's shortcuts) have no node as their target.
      if (!(event.target instanceof Node) || !dom.contains(event.target)) return
      const shown = Boolean(bar.current?.isConnected)
      if (event.key === 'Escape' && shown) {
        hide()
        return
      }
      // Alt+F10 comes to this bar while it shows, otherwise to the toolbar (its own listener on the text).
      if (event.altKey && event.key === 'F10' && shown) {
        event.preventDefault()
        event.stopPropagation()
        bar.current?.querySelector<HTMLElement>('[data-tool][tabindex="0"]')?.focus()
        return
      }
      if (!event.altKey && !event.ctrlKey && !event.metaKey) byTouch.current = false
    }
    dom.addEventListener('pointerdown', pointer)
    window.addEventListener('keydown', keys, true)
    return () => {
      dom.removeEventListener('pointerdown', pointer)
      window.removeEventListener('keydown', keys, true)
    }
  }, [editor, hide])

  // A menu of the bar opened from the keyboard takes the focus at its first entry.
  useEffect(() => {
    if (open && bar.current?.contains(document.activeElement)) bar.current.querySelector<HTMLElement>('[role="menu"] [role^="menuitem"]')?.focus()
  }, [open])

  const options = useMemo(
    () => ({
      placement: 'top' as const,
      offset: 8,
      // Below the selection where the note's toolbar (it stays at the top) leaves no room above it; never cut off.
      flip: { padding: { top: headHeight + 8, bottom: 8 } },
      shift: { padding: 8 },
      onHide: () => setOpen(null),
    }),
    [headHeight],
  )

  if (!state) return null
  const chain = () => editor.chain().focus()
  const tools: Tool[] = [
    { key: 'bold', label: t('editor.tools.bold'), shortcut: `${MOD}+B`, icon: Bold, active: state.bold, run: () => chain().toggleBold().run() },
    { key: 'italic', label: t('editor.tools.italic'), shortcut: `${MOD}+I`, icon: Italic, active: state.italic, run: () => chain().toggleItalic().run() },
    { key: 'underline', label: t('editor.tools.underline'), shortcut: `${MOD}+U`, icon: Underline, active: state.underline, run: () => chain().toggleUnderline().run() },
    { key: 'strike', label: t('editor.tools.strike'), shortcut: `${MOD}+Shift+S`, icon: Strikethrough, active: state.strike, run: () => chain().toggleStrike().run() },
    { key: 'highlight', label: t('editor.tools.highlight'), shortcut: `${MOD}+Shift+H`, icon: Highlighter, active: state.highlight, run: () => chain().setHighlight({ color: HIGHLIGHT_COLORS[0] }).run() },
    { key: 'highlight-colors', label: t('editor.tools.highlightColors'), icon: ChevronDown, run: () => setOpen(open === 'highlight' ? null : 'highlight') },
    { key: 'link', label: t('editor.tools.link'), shortcut: `${MOD}+${ALT}+K`, icon: LinkIcon, active: state.link, run: onLink },
    {
      key: 'code',
      label: t('editor.tools.code'),
      shortcut: `${MOD}+E`,
      icon: Code,
      active: state.code,
      // As in the toolbar: inside a line code in the text, over several lines a code block.
      run: () => {
        const { $from, $to } = editor.state.selection
        if ($from.sameParent($to)) chain().toggleCode().run()
        else chain().toggleCodeBlock().run()
      },
    },
    { key: 'style', label: t('editor.tools.style'), icon: ChevronDown, run: () => setOpen(open === 'style' ? null : 'style') },
    { key: 'clear', label: t('editor.tools.clear'), icon: RemoveFormatting, run: () => chain().unsetAllMarks().run() },
  ]
  const styles = [
    ['h1', () => chain().setHeading({ level: 1 }).run()],
    ['h2', () => chain().setHeading({ level: 2 }).run()],
    ['p', () => chain().setParagraph().run()],
  ] as const

  const move = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const inMenu = (event.target as HTMLElement).closest('[role="menu"]')
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      // In a menu: the menu closes, back to its button; in the bar: back to the text, the selection kept.
      if (inMenu) {
        setOpen(null)
        bar.current?.querySelector<HTMLElement>('[data-tool][tabindex="0"]')?.focus()
        return
      }
      hide()
      editor.commands.focus()
      return
    }
    const items = Array.from(bar.current?.querySelectorAll<HTMLElement>(inMenu ? '[role="menu"] [role^="menuitem"]' : '[data-tool]') ?? [])
    const at = items.indexOf(document.activeElement as HTMLElement)
    if (at < 0) return
    const next = inMenu
      ? ({ ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 } as Record<string, number>)[event.key]
      : ({ ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: items.length - 1 } as Record<string, number>)[event.key]
    if (next === undefined) return
    event.preventDefault()
    const index = (next + items.length) % items.length
    if (!inMenu) setFocusAt(index)
    items[index]?.focus()
  }

  const menuItem = (key: string, label: string, run: () => void, extra: { checked?: boolean; swatch?: string } = {}) => (
    <button
      key={key}
      type="button"
      role={extra.checked === undefined ? 'menuitem' : 'menuitemradio'}
      aria-checked={extra.checked}
      className="nn-menu-item"
      data-testid={`selection-${key}`}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        setOpen(null)
        run()
      }}
    >
      {extra.swatch !== undefined && <span aria-hidden className={'nn-swatch' + (extra.swatch ? '' : ' nn-swatch-none')} data-color={extra.swatch || undefined} />}
      {extra.checked !== undefined && <span aria-hidden className="w-4 text-accent-400">{extra.checked ? '✓' : ''}</span>}
      {label}
    </button>
  )

  return (
    <BubbleMenu
      editor={editor}
      pluginKey={SELECTION_BAR}
      shouldShow={shouldShow}
      updateDelay={120}
      options={options}
      className="z-30"
      data-selection-bar=""
    >
      <div
        ref={bar}
        role="toolbar"
        aria-label={t('editor.tools.selection')}
        onKeyDown={move}
        data-testid="selection-bar"
        className="relative flex items-center gap-0.5 rounded-[10px] border border-ink-700 bg-ink-850 p-1 shadow-xl shadow-black/30"
      >
        {tools.map((tool, index) => {
          const Icon = tool.icon
          const menu = tool.key === 'style' || tool.key === 'highlight-colors'
          const narrow = tool.key === 'highlight-colors'
          return (
            <span key={tool.key} className="flex shrink-0 items-center">
              {(tool.key === 'link' || tool.key === 'style' || tool.key === 'clear') && <span aria-hidden className="mx-1 h-5 w-px bg-ink-700" />}
              <button
                type="button"
                data-tool
                data-testid={`selection-tool-${tool.key}`}
                tabIndex={focusAt === index ? 0 : -1}
                onFocus={() => setFocusAt(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={tool.run}
                aria-label={tool.label}
                aria-pressed={menu ? undefined : tool.key === 'clear' || tool.key === 'link' ? undefined : tool.active}
                aria-haspopup={menu ? 'menu' : undefined}
                aria-expanded={menu ? open === (tool.key === 'style' ? 'style' : 'highlight') : undefined}
                title={tool.shortcut ? `${tool.label} (${tool.shortcut})` : tool.label}
                className={`flex h-[30px] items-center justify-center gap-1 rounded-lg transition-colors ${narrow ? 'w-4 -ml-0.5' : tool.key === 'style' ? 'px-2 text-[12.5px]' : 'w-[30px]'} ${tool.active ? 'nn-chosen' : 'text-mist-300 hover:bg-ink-800 hover:text-mist-100'}`}
              >
                {tool.key === 'style' && <span>{t(`editor.style.${state.style}`)}</span>}
                <Icon className={narrow || tool.key === 'style' ? 'h-3 w-3' : 'h-4 w-4'} strokeWidth={tool.key === 'bold' ? 2.6 : 2} aria-hidden />
              </button>
            </span>
          )
        })}
        {open && (
          <div role="menu" aria-label={open === 'style' ? t('editor.tools.style') : t('editor.tools.highlightColors')} className="nn-menu absolute top-full left-0 mt-1" data-testid={`selection-menu-${open}`}>
            {open === 'style'
              ? styles.map(([value, run]) => menuItem(`style-${value}`, t(`editor.style.${value}`), run, { checked: state.style === value }))
              : [
                  ...HIGHLIGHT_COLORS.map((color) => menuItem(`highlight-${color}`, t(`editor.colors.${color}`), () => chain().setHighlight({ color }).run(), { swatch: color })),
                  menuItem('highlight-none', t('editor.colors.none'), () => chain().unsetHighlight().run(), { swatch: '' }),
                ]}
          </div>
        )}
      </div>
    </BubbleMenu>
  )
}
