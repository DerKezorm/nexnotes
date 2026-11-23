/**
 * The tiles at the top of the sidebar (NOTES-4 AC-16), as in the iOS app's page "Ordner": two of the same size per
 * row, "Eingang" (honey, dark writing, with "n Titel prüfen" when notes there wait for it) and "Alle Notizen" (green),
 * below alone "Mit mir geteilt" (blue, NOTES-13 AC-3). Each with its symbol at the top left, its number at the top
 * right and its name below; the one of the place on show is marked (a ring in the writing's colour of the sidebar).
 * The colours are the same in light and dark: each tile is its own ground, its writing reaches 4.5:1 on it.
 *
 * Notes dropped on "Eingang" go back into it (as the inbox entry before, NOTES-4 AC-3). The same tiles stand at the
 * top of the phone's page "Ordner" (NOTES-23 AC-1).
 */
import { Inbox, NotebookText, Users, type LucideIcon } from 'lucide-react'
import { useState, type DragEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation } from 'react-router-dom'

import { draggedNow, droppedFrom, endDrag } from './actions'
import { accepts, drop } from './drop'
import { useFolders } from './store'
import { TILE_COLORS, TITLE_CHECK_COLORS } from './tileColors'

type TileProps = {
  to: string
  /** Whether the place on show is this tile's ("Alle Notizen" also with a note open, `/notes/<id>`). */
  shows: (path: string) => boolean
  testId: string
  title: string
  count: number | null
  /** What a screen reader says: the name first, then the number (and the mark). */
  label: string
  Icon: LucideIcon
  colors: { ground: string; ink: string }
  onNavigate?: () => void
  drag?: { over: boolean; take: (event: DragEvent) => void; leave: () => void; put: (event: DragEvent) => void }
  children?: ReactNode
}

function Tile({ to, shows, testId, title, count, label, Icon, colors, onNavigate, drag, children }: TileProps) {
  const active = shows(useLocation().pathname)
  return (
    <Link
      to={to}
      aria-current={active ? 'page' : undefined}
      onClick={onNavigate}
      data-testid={testId}
      aria-label={label}
      onDragOver={drag?.take}
      onDragEnter={drag?.take}
      onDragLeave={drag?.leave}
      onDrop={drag?.put}
      style={{ backgroundColor: colors.ground, color: colors.ink }}
      className={
        'flex min-h-12 min-w-0 flex-col justify-between gap-1.5 rounded-[14px] p-2.5 transition-[filter] hover:brightness-95 ' +
        (active ? 'ring-2 ring-mist-100 ring-offset-2 ring-offset-ink-900' : '') +
        (drag?.over ? ' outline-2 outline-offset-2 outline-accent-500' : '')
      }
    >
      <span className="flex items-start justify-between gap-2">
        <span aria-hidden className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg" style={{ backgroundColor: 'rgb(255 255 255 / 0.18)' }}>
          <Icon className="h-4 w-4" strokeWidth={2.2} />
        </span>
        <span className="text-[20px] leading-none font-bold tabular-nums" data-testid="tile-count">
          {count ?? ''}
        </span>
      </span>
      <span className="flex min-w-0 flex-col items-start gap-1">
        <span className="w-full truncate text-[13px] font-semibold" title={title}>
          {title}
        </span>
        {children}
      </span>
    </Link>
  )
}

export function QuickTiles({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation()
  const tree = useFolders()
  const [over, setOver] = useState(false)
  const inbox = tree.inbox
  const places = tree.places
  const check = places?.inbox_title_check ?? 0
  const take = (event: DragEvent) => {
    if (!inbox || !accepts(tree, draggedNow(), inbox.id, 'into', true)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setOver(true)
  }
  const label = (name: string, number: number | null, extra = '') =>
    (number === null ? name : t('folders.tiles.label', { name, count: number })) + (extra ? `, ${extra}` : '')
  const put = (event: DragEvent) => {
    event.preventDefault()
    setOver(false)
    const dragged = droppedFrom(event)
    endDrag()
    if (inbox && dragged?.kind === 'notes') void drop(tree, dragged, inbox.id, 'into')
  }
  return (
    <div className="grid grid-cols-2 gap-2 pt-1 pb-3" data-testid="quick-tiles">
      <Tile
        to="/inbox"
        shows={(path) => path === '/inbox' || path.startsWith('/inbox/')}
        testId="sidebar-inbox"
        title={t('folders.inbox.name')}
        count={inbox ? inbox.count : null}
        label={label(t('folders.inbox.name'), inbox ? inbox.count : null, check > 0 ? t('folders.tiles.titleCheck', { count: check }) : '')}
        Icon={Inbox}
        colors={TILE_COLORS.inbox}
        onNavigate={onNavigate}
        drag={{ over, take, leave: () => setOver(false), put }}
      >
        {check > 0 && (
          <span
            className="max-w-full truncate rounded-full px-1.5 py-0.5 text-[11px] leading-tight font-semibold"
            style={{ backgroundColor: TITLE_CHECK_COLORS.ground, color: TITLE_CHECK_COLORS.ink }}
            data-testid="tile-title-check"
          >
            {t('folders.tiles.titleCheck', { count: check })}
          </span>
        )}
      </Tile>
      <Tile
        to="/"
        shows={(path) => path === '/' || path.startsWith('/notes/')}
        testId="sidebar-all"
        title={t('notes.all')}
        count={places ? places.all : null}
        label={label(t('notes.all'), places ? places.all : null)}
        Icon={NotebookText}
        colors={TILE_COLORS.all}
        onNavigate={onNavigate}
      />
      <Tile
        to="/shared"
        shows={(path) => path === '/shared' || path.startsWith('/shared/')}
        testId="sidebar-shared"
        title={t('shares.page.title')}
        count={places ? places.shared : null}
        label={label(t('shares.page.title'), places ? places.shared : null)}
        Icon={Users}
        colors={TILE_COLORS.shared}
        onNavigate={onNavigate}
      />
    </div>
  )
}
