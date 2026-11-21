/**
 * The notes of a folder, or all of them (NOTES-6): sorted and grouped as the account chose for this folder, drawn the
 * way the account chose for every list (list, cards, compact, tiles; with hints or without, `list/look.ts`), pinned
 * notes on top, groups to fold shut, colors, marks, an empty state, and the same on the phone and in the column or
 * drawer beside open notes. Folder pages, smart folders and "All notes" use it; without `folderId` it shows all own
 * notes and those shared with the account, with their folders (AC-7).
 *
 * Above the notes the head every list has (`list/ListHead.tsx`): path, symbol, name, count, "Ansicht" and the list's
 * own "…", and a line saying how it is sorted and grouped. Without `heading` (a page with a head of its own) only that
 * line and "Ansicht".
 *
 * Every list of notes uses it: a folder, "All notes", a smart folder, the inbox (where a note came from, "Einsortieren"),
 * the page of a tag (whose a note is), a folder somebody shared. What such a list adds to its notes comes in through
 * `decorate`; the search alone keeps its own list of hits.
 *
 * The pieces live in `notes/list/`: the server's routes (`api.ts`), the order and the date groups (`order.ts`), the
 * fixed-height layout and the window over it (`layout.ts`, `Window.tsx`), rows, cards, compact rows, tiles, the menus.
 */
import { ChevronDown, ChevronRight, FileText, Plus } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router-dom'

import { draggedNow, droppedFrom, endDrag, startNoteDrag, useNoteActions } from '../folders/actions'
import { drop } from '../folders/drop'
import { colorOf } from '../folders/palette'
import { useFolders } from '../folders/store'
import { tryLeave } from './context'
import { listDate } from './listDate'
import { noteHref } from './newNote'
import { noteOf } from './workspace'
import type { ListItem, ListMode } from './list/api'
import { useCollapsed } from './list/collapsed'
import type { ItemDecor, ItemProps, RowFolder } from './list/ItemParts'
import { ItemMenu } from './list/ItemMenu'
import { layout, SIZES, type Entry } from './list/layout'
import { ListHead } from './list/ListHead'
import './list/list.css'
import { saveListLook, useListLook } from './list/look'
import { NoteCard } from './list/NoteCard'
import { NoteCompact } from './list/NoteCompact'
import { NoteRow } from './list/NoteRow'
import { NoteTile } from './list/NoteTile'
import { arrange, sectionLabel } from './list/order'
import { useNoteList, type ListSource } from './list/useNoteList'
import { useNow } from './list/useNow'
import { useTouch } from './list/useTouch'
import { viewSummary } from './list/summary'
import { ViewMenu } from './list/ViewMenu'
import { Window } from './list/Window'

export type NoteListProps = {
  /** Only the notes of this folder; all notes (own and shared) when left out. */
  folderId?: string
  /** The open note, marked in the list; by default the one the address names. */
  selectedId?: string
  /** Opens a note; by default the note page `/notes/<id>`. */
  onOpen?: (id: string) => void
  /** The address of a note, for the link (opening in a new tab); by default `/notes/<id>`, with the folder. */
  hrefFor?: (id: string) => string
  /** The name of the list in its head; without one only "Ansicht" and the line under it (the page has a head). */
  heading?: string
  /** The path above the name (a folder's folders). */
  crumb?: ReactNode
  /** The list's symbol before its name. */
  icon?: ReactNode
  /** The list's own buttons in its head, after "Ansicht": a folder's "…". */
  actions?: ReactNode
  /** Another list than a folder's (a smart folder, NOTES-7): where its notes come from. Rows show their folders. */
  source?: ListSource
  /** What an empty list says instead of the folder's empty state (a smart folder names its conditions, EC-2). */
  empty?: ReactNode
  /** What the list can show besides its notes: `gallery` shows `gallery` in the place of the notes. */
  modes?: readonly ListMode[]
  gallery?: ReactNode
  /** The count in the head instead of "12 Notizen" (the page of a tag: "3 Notizen, davon 1 von Lena"). */
  count?: string
  /** What stands between the head and the notes: a sentence about the list, a shared folder's folders. */
  intro?: ReactNode
  /** What the list adds to each note: a sign, another place than its folder, buttons (`ItemDecor`). */
  decorate?: (item: ListItem) => ItemDecor | undefined
}

/** The width of the list, followed as it changes; unknown (a test without layout) counts as a wide screen. */
function useWidth(box: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(1024)
  useEffect(() => {
    const element = box.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry.contentRect.width)
      if (next > 0) setWidth(next)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [box])
  return width
}

export function NoteList({ folderId, selectedId: chosenId, onOpen, hrefFor, heading, crumb, icon, actions, source, empty, modes, gallery, count, intro, decorate }: NoteListProps) {
  const href = hrefFor ?? ((id: string) => noteHref(id, folderId))
  const location = useLocation()
  const selectedId = chosenId ?? noteOf(location.pathname, location.search) ?? undefined
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const navigate = useNavigate()
  const tree = useFolders()
  const { newNote } = useNoteActions()
  const { answer, failed, view: kept, setView, pin, color } = useNoteList(folderId, source)
  // A gallery kept for a list that offers none (its conditions changed) shows as a list.
  const showsGallery = kept.mode === 'gallery' && Boolean(gallery) && Boolean(modes?.includes('gallery'))
  const view = useMemo(() => (kept.mode === 'gallery' && !showsGallery ? { ...kept, mode: 'list' as const } : kept), [kept, showsGallery])
  const look = useListLook()
  const touch = useTouch()
  const { collapsed, toggle } = useCollapsed(source?.key ?? folderId ?? 'all')
  const now = useNow()
  const box = useRef<HTMLElement>(null)
  const width = useWidth(box)
  const narrow = width < SIZES.narrow
  const all = !folderId
  const [menu, setMenu] = useState<{ item: ListItem; point: { x: number; y: number } } | null>(null)
  const [over, setOver] = useState(false)

  const sections = useMemo(() => (answer ? arrange(answer.items, view, now, lang) : []), [answer, view, now, lang])
  const { entries, height, columns } = useMemo(
    () => layout(sections, look.style, width, { hints: look.hints, collapsed, touch }),
    [sections, look.style, look.hints, width, collapsed, touch],
  )

  const folderOf = useCallback(
    (item: ListItem): RowFolder | null => {
      if (!all) return null
      if (item.owner) return { name: t('noteList.sharedFolder'), color: 'var(--color-mist-500)' }
      if (tree.inbox?.id === item.folder_id) return { name: t('notes.inbox'), color: 'var(--color-mist-500)' }
      const folder = tree.byId.get(item.folder_id)
      return folder ? { name: folder.name, color: colorOf(folder.color) } : { name: '', color: 'var(--color-ink-600)' }
    },
    [all, t, tree],
  )

  const opener = (id: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) return
    event.preventDefault()
    if (onOpen) return tryLeave(() => onOpen(id))
    const to = href(id)
    tryLeave(() => navigate(to), to)
  }
  const openMenu = useCallback((item: ListItem, point: { x: number; y: number }) => setMenu({ item, point }), [])
  const closeMenu = useCallback(() => setMenu(null), [])
  const dragOf = (item: ListItem) => (item.owner ? undefined : (event: DragEvent) => startNoteDrag(event, [item.id]))

  // Every look shows when a note last changed (AC-2), whatever the list is sorted by.
  const propsOf = (item: ListItem, first = false): ItemProps => {
    const decor = decorate?.(item)
    return {
      item,
      href: href(item.id),
      chosen: item.id === selectedId,
      date: listDate(item.updated_at, lang, now),
      folder: decor && 'folder' in decor ? decor.folder : folderOf(item),
      hints: look.hints,
      first,
      onOpen: opener(item.id),
      onMenu: item.owner ? undefined : openMenu,
      onDragStart: dragOf(item),
      onDragEnd: endDrag,
      mark: decor?.mark,
      actions: decor?.actions,
    }
  }
  const render = (entry: Entry) => {
    if (entry.kind === 'header') {
      const Chevron = entry.collapsed ? ChevronRight : ChevronDown
      return (
        <h2 className="h-full">
          <button
            type="button"
            aria-expanded={!entry.collapsed}
            onClick={() => toggle(entry.section)}
            className="flex h-full w-full items-end gap-1.5 rounded-md px-3 pb-1.5 text-left text-[11px] font-semibold tracking-[0.08em] text-mist-600 uppercase hover:text-mist-300"
            data-testid="list-group-toggle"
            data-section={entry.section}
          >
            <Chevron aria-hidden className="mb-px h-3 w-3 shrink-0" strokeWidth={2.6} />
            <span className="min-w-0 truncate" data-testid="list-group-heading">
              {sectionLabel(entry.section, t, lang, now)}
            </span>
            <span className="shrink-0 font-medium tracking-normal normal-case" data-testid="list-group-count">
              · {entry.count}
            </span>
          </button>
        </h2>
      )
    }
    if (entry.kind === 'row') {
      const props = propsOf(entry.item, entry.first)
      return look.style === 'compact' ? <NoteCompact {...props} /> : <NoteRow {...props} />
    }
    const cards = look.style === 'cards'
    const gap = cards ? SIZES.cardGap : narrow ? SIZES.smallGap : SIZES.gap
    return (
      <div className="grid h-full" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap, paddingBottom: gap }}>
        {entry.items.map((item) => (cards ? <NoteCard key={item.id} {...propsOf(item)} /> : <NoteTile key={item.id} {...propsOf(item)} />))}
      </div>
    )
  }

  const folderName = folderId ? (tree.inbox?.id === folderId ? t('notes.inbox') : (tree.byId.get(folderId)?.name ?? '')) : ''
  const counts = answer?.counts
  // A folder somebody shared holds only notes of others: they count for it as its own do.
  const countText =
    count ??
    (!counts
      ? ''
      : all
        ? counts.shared > 0
          ? t('noteList.countsShared', { own: counts.own, shared: counts.shared })
          : t('noteList.count', { count: counts.own })
        : t('noteList.count', { count: counts.own + counts.shared }))

  const viewMenu = <ViewMenu view={view} onChange={setView} look={look} onLook={(change) => void saveListLook(change)} modes={modes} />
  const summary = viewSummary(view, look, t, showsGallery)

  const takeNotes = (event: DragEvent) => {
    if (!folderId || draggedNow()?.kind !== 'notes') return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setOver(true)
  }

  return (
    <section
      ref={box}
      aria-label={heading ?? t('notes.list.title')}
      className="flex min-h-0 min-w-0 flex-col gap-3"
      data-testid="note-list"
      data-folder={folderId ?? ''}
      data-mode={view.mode}
      data-style={look.style}
    >
      {heading ? (
        <ListHead heading={heading} crumb={crumb} icon={icon} count={countText} view={viewMenu} actions={actions} summary={summary} narrow={narrow} />
      ) : (
        <div className="flex min-w-0 items-center gap-2 px-1">
          <p className="min-w-0 flex-1 truncate text-[12px] text-mist-600" data-testid="list-state">
            {summary}
          </p>
          {viewMenu}
        </div>
      )}
      {intro}
      {failed && <p className="px-2 text-sm text-bad-500">{t('notes.list.failed')}</p>}
      {showsGallery && gallery}
      {!showsGallery && answer && answer.items.length === 0 && empty}
      {!showsGallery && answer && answer.items.length === 0 && !empty && (
        <div
          data-testid="list-empty"
          onDragOver={takeNotes}
          onDragEnter={takeNotes}
          onDragLeave={() => setOver(false)}
          onDrop={(event) => {
            if (!folderId) return
            event.preventDefault()
            setOver(false)
            const dragged = droppedFrom(event)
            endDrag()
            if (dragged?.kind === 'notes') void drop(tree, dragged, folderId, 'into')
          }}
          className={
            'flex min-h-[320px] flex-col items-center justify-center gap-3.5 rounded-[16px] border border-dashed p-6 text-center ' +
            (over ? 'border-accent-500 bg-accent-wash' : 'border-ink-600')
          }
        >
          <FileText aria-hidden className="h-12 w-12 text-accent-400" strokeWidth={1.3} />
          <p className="text-lg font-semibold">{folderId ? t('folders.page.emptyTitle', { name: folderName }) : t('noteList.emptyAll')}</p>
          <p className="max-w-sm text-sm leading-relaxed text-mist-500">{folderId ? t('folders.page.emptyText') : t('noteList.emptyAllText')}</p>
          {newNote && (folderId ?? tree.inbox?.id) && (
            <button type="button" className="nn-btn nn-btn-accent" onClick={() => newNote((folderId ?? tree.inbox?.id)!)} data-testid="list-empty-new">
              <Plus aria-hidden className="h-4 w-4" />
              {folderId ? t('folders.page.newNote', { name: folderName }) : t('notes.new')}
            </button>
          )}
        </div>
      )}
      {!showsGallery && answer && answer.items.length > 0 && <Window entries={entries} height={height} render={render} />}
      {menu && (
        <ItemMenu
          item={answer?.items.find((item) => item.id === menu.item.id) ?? menu.item}
          point={menu.point}
          onPin={(pinned) => pin(menu.item, pinned)}
          onColor={(value) => color(menu.item, value)}
          onClose={closeMenu}
        />
      )}
    </section>
  )
}
