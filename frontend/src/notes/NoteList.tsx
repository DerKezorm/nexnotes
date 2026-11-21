/**
 * The notes of a folder, or all of them (NOTES-6): as a list or as tiles with a preview, sorted and grouped as the
 * account chose for this folder, pinned notes on top, colors, marks, an empty state, and the same on the phone.
 * Folder pages, the inbox's column and "All notes" use it; without `folderId` it shows all own notes and those shared
 * with the account, with their folders (AC-7).
 *
 * The pieces live in `notes/list/`: the server's routes (`api.ts`), the order and the date groups (`order.ts`), the
 * fixed-height layout and the window over it (`layout.ts`, `Window.tsx`), rows, tiles, the menu and the bar.
 */
import { FileText, Plus } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'

import { draggedNow, droppedFrom, endDrag, startNoteDrag, useNoteActions } from '../folders/actions'
import { drop } from '../folders/drop'
import { colorOf } from '../folders/palette'
import { useFolders } from '../folders/store'
import { tryLeave } from './context'
import { listDate } from './listDate'
import { noteHref } from './newNote'
import type { ListItem } from './list/api'
import { ItemMenu } from './list/ItemMenu'
import { layout, SIZES, type Entry } from './list/layout'
import { ListBar } from './list/ListBar'
import './list/list.css'
import { NoteRow, type RowFolder } from './list/NoteRow'
import { NoteTile } from './list/NoteTile'
import { arrange, dateOf, sectionLabel } from './list/order'
import { useNoteList } from './list/useNoteList'
import { useNow } from './list/useNow'
import { Window } from './list/Window'

export type NoteListProps = {
  /** Only the notes of this folder; all notes (own and shared) when left out. */
  folderId?: string
  /** The open note, marked in the list. */
  selectedId?: string
  /** Opens a note; by default the note page `/notes/<id>`. */
  onOpen?: (id: string) => void
  /** The address of a note, for the link (opening in a new tab); by default `/notes/<id>`, with the folder. */
  hrefFor?: (id: string) => string
  /** A heading above the list. */
  heading?: string
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

export function NoteList({ folderId, selectedId, onOpen, hrefFor, heading }: NoteListProps) {
  const href = hrefFor ?? ((id: string) => noteHref(id, folderId))
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const navigate = useNavigate()
  const tree = useFolders()
  const { newNote } = useNoteActions()
  const { answer, failed, view, setView, pin, color } = useNoteList(folderId)
  const now = useNow()
  const box = useRef<HTMLElement>(null)
  const width = useWidth(box)
  const narrow = width < SIZES.narrow
  const all = !folderId
  const [menu, setMenu] = useState<{ item: ListItem; point: { x: number; y: number } } | null>(null)
  const [over, setOver] = useState(false)

  const sections = useMemo(() => (answer ? arrange(answer.items, view, now, lang) : []), [answer, view, now, lang])
  const { entries, height, columns } = useMemo(() => layout(sections, view.mode, width), [sections, view.mode, width])

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
    tryLeave(() => (onOpen ? onOpen(id) : navigate(href(id))))
  }
  const openMenu = useCallback((item: ListItem, point: { x: number; y: number }) => setMenu({ item, point }), [])
  const closeMenu = useCallback(() => setMenu(null), [])
  const dragOf = (item: ListItem) => (item.owner ? undefined : (event: DragEvent) => startNoteDrag(event, [item.id]))

  const render = (entry: Entry) => {
    if (entry.kind === 'header')
      return (
        <h2 className="flex h-full items-end px-2.5 pb-2 text-[12px] font-semibold tracking-[0.06em] text-mist-500 uppercase" data-testid="list-group-heading">
          {sectionLabel(entry.section, t, lang, now)}
        </h2>
      )
    if (entry.kind === 'row') {
      const item = entry.item
      return (
        <NoteRow
          item={item}
          href={href(item.id)}
          chosen={item.id === selectedId}
          date={listDate(dateOf(item, view), lang, now)}
          folder={folderOf(item)}
          wide={all && width >= 760}
          onOpen={opener(item.id)}
          onMenu={item.owner ? undefined : openMenu}
          onDragStart={dragOf(item)}
          onDragEnd={endDrag}
        />
      )
    }
    const gap = narrow ? SIZES.smallGap : SIZES.gap
    return (
      <div className="grid h-full" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap, paddingBottom: gap }}>
        {entry.items.map((item) => (
          <NoteTile
            key={item.id}
            item={item}
            href={href(item.id)}
            chosen={item.id === selectedId}
            date={listDate(dateOf(item, view), lang, now)}
            onOpen={opener(item.id)}
            onMenu={item.owner ? undefined : openMenu}
            onDragStart={dragOf(item)}
            onDragEnd={endDrag}
          />
        ))}
      </div>
    )
  }

  const folderName = folderId ? (tree.inbox?.id === folderId ? t('notes.inbox') : (tree.byId.get(folderId)?.name ?? '')) : ''
  const counts = answer?.counts
  const countText = !counts
    ? ''
    : all
      ? counts.shared > 0
        ? t('noteList.countsShared', { own: counts.own, shared: counts.shared })
        : t('noteList.count', { count: counts.own })
      : t('noteList.count', { count: counts.own })

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
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 px-1">
        {heading && (
          <h1 className={'min-w-0 truncate font-bold text-mist-100 ' + (narrow ? 'text-[19px]' : 'text-2xl')} title={heading}>
            {heading}
          </h1>
        )}
        {heading && countText && <span className="shrink-0 text-[13px] text-mist-500" data-testid="list-counts">{countText}</span>}
        <span className="ml-auto">
          <ListBar view={view} onChange={setView} narrow={narrow} />
        </span>
      </div>
      {failed && <p className="px-2 text-sm text-bad-500">{t('notes.list.failed')}</p>}
      {answer && answer.items.length === 0 && (
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
      {answer && answer.items.length > 0 && <Window entries={entries} height={height} render={render} />}
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
