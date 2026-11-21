/**
 * The pages of the folders (NOTES-4): a folder with its path at the top (every step a link, AC-13) and its notes below,
 * or the empty state of NOTES-6 EC-1 (EC-5); the inbox, a list like the folders, with where each note came from
 * (AC-7), "File" (AC-14) and its own empty state (EC-6); and on the phone the list of all folders (drawing
 * "Handy-Ordner").
 */
import { Braces, CheckCheck, ChevronDown, ChevronRight, FileText, FolderInput, Inbox, LayoutGrid, Mic, MoreHorizontal, NotebookText, PenLine, Plug, Plus, Share2, StickyNote, Zap } from 'lucide-react'
import { useCallback, useEffect, useState, type DragEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, Navigate, useLocation, useParams } from 'react-router-dom'

import { LogoMark } from '../components/Logo'
import { PHONE_FOLDER_SECTIONS } from '../extensions'
import { notesApi, notesChanged } from '../notes/api'
import { NoteList } from '../notes/NoteList'
import type { ListItem } from '../notes/list/api'
import type { ItemAction, ItemDecor } from '../notes/list/ItemParts'
import { ListHead } from '../notes/list/ListHead'
import { hrefIn } from '../notes/workspace'
import { problemText } from '../lib/errors'
import { useListPadding, useListTitle } from '../notes/listPlace'
import { PhoneBack, PhoneNewNote } from '../pwa/phone'
import type { Folder } from './api'
import { draggedNow, droppedFrom, endDrag, useNoteActions } from './actions'
import { useFolderActions } from './useFolderActions'
import { drop } from './drop'
import { FolderMark } from './FolderMark'
import { FolderMenu } from './FolderMenu'
import { colorOf } from './palette'
import { originText } from './origin'
import { flatten, pathOf, revealFolder, setFolderOpen, useFolders, useOpenFolders } from './store'

// The open folder for "New note" (AC-9) follows the list on show: the notes' workspace sets it (`NotesPage`), whether
// the list has room beside the notes or not.

// ---- A folder --------------------------------------------------------------------------------------------------------

export function FolderPage() {
  const { t } = useTranslation()
  const id = useParams().id ?? ''
  const tree = useFolders()
  const actions = useFolderActions()
  const { newNote } = useNoteActions()
  const [menu, setMenu] = useState<HTMLElement | null>(null)
  const [over, setOver] = useState(false)
  const folder = tree.byId.get(id)
  const location = useLocation()
  const padding = useListPadding()
  useListTitle(folder?.name ?? t('folders.section'))
  useEffect(() => {
    if (tree.status === 'ready' && tree.byId.has(id)) revealFolder(id)
  }, [id, tree.status, tree.byId])

  if (tree.inbox?.id === id) return <Navigate to={`/inbox${location.search}`} replace state={location.state} />
  if (tree.status !== 'ready' && !folder) return null
  if (!folder)
    return (
      <div className="p-6 text-sm text-mist-400" data-testid="folder-gone">
        {t('folders.page.gone')}
      </div>
    )

  const path = pathOf(tree, id)
  // On a phone: back to the folder above, or to all folders (NOTES-23 AC-1).
  const parent = path.length > 1 ? path[path.length - 2] : null
  const takeNotes = (event: DragEvent) => {
    if (draggedNow()?.kind !== 'notes') return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setOver(true)
  }

  // The head every list has (`ListHead`): the path small above, symbol, name, count, "Ansicht" and the folder's menu.
  const crumb = (
    <nav aria-label={t('folders.page.path')} className="flex min-w-0 flex-wrap items-center gap-1">
      {path.map((step, index) =>
        index < path.length - 1 ? (
          <span key={step.id} className="flex min-w-0 items-center gap-1">
            <Link to={`/folder/${step.id}`} className="max-w-[16ch] truncate text-mist-500 hover:text-accent-400 hover:underline" title={step.name}>
              {step.name}
            </Link>
            <span aria-hidden>›</span>
          </span>
        ) : (
          <span key={step.id} aria-current="page" className="sr-only">
            {step.name}
          </span>
        ),
      )}
    </nav>
  )
  const icon = (
    <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[8px]" style={{ background: `color-mix(in srgb, ${colorOf(folder.color)} 16%, transparent)` }}>
      <FolderMark folder={folder.icon ? folder : { ...folder, icon: 'folder' }} size={17} />
    </span>
  )
  const more = (
    <button
      type="button"
      aria-label={t('folders.menu.label', { name: folder.name })}
      aria-haspopup="menu"
      aria-expanded={Boolean(menu)}
      onClick={(event) => setMenu(menu ? null : event.currentTarget)}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-mist-500 hover:bg-ink-800 hover:text-mist-100"
      data-testid="folder-more"
    >
      <MoreHorizontal aria-hidden className="h-4 w-4" />
    </button>
  )

  return (
    <div className={'flex min-h-full flex-col gap-3 ' + padding} data-testid="folder-page">
      <PhoneBack to={parent ? `/folder/${parent.id}` : '/folders'} label={parent ? parent.name : t('folders.section')} />
      {folder.count === 0 && <ListHead heading={folder.name} crumb={crumb} icon={icon} count={t('folders.count.notes', { count: 0 })} actions={more} />}
      {folder.count === 0 ? (
        <div
          data-testid="folder-empty"
          onDragOver={takeNotes}
          onDragEnter={takeNotes}
          onDragLeave={() => setOver(false)}
          onDrop={(event) => {
            event.preventDefault()
            setOver(false)
            const dragged = droppedFrom(event)
            endDrag()
            if (dragged?.kind === 'notes') void drop(tree, dragged, folder.id, 'into')
          }}
          className={'flex min-h-[420px] flex-1 flex-col items-center justify-center gap-3.5 rounded-[16px] border border-dashed p-6 text-center ' + (over ? 'border-accent-500 bg-[var(--color-accent-wash)]' : 'border-ink-600')}
        >
          <FileText aria-hidden className="h-12 w-12 text-accent-400" strokeWidth={1.3} />
          <p className="text-lg font-semibold">{t('folders.page.emptyTitle', { name: folder.name })}</p>
          <p className="max-w-sm text-sm leading-relaxed text-mist-500">{t('folders.page.emptyText')}</p>
          {newNote && (
            <button type="button" className="nn-btn nn-btn-accent" onClick={() => newNote(folder.id)}>
              {t('folders.page.newNote', { name: folder.name })}
            </button>
          )}
        </div>
      ) : (
        <NoteList folderId={folder.id} heading={folder.name} crumb={crumb} icon={icon} actions={more} />
      )}
      {newNote && <PhoneNewNote onClick={() => newNote(folder.id)} label={t('folders.page.newNote', { name: folder.name })} />}
      {menu && <FolderMenu folder={folder} anchor={menu} onClose={() => setMenu(null)} onAction={(action) => actions.act(action, folder)} />}
      {actions.node}
    </div>
  )
}

// ---- The inbox -------------------------------------------------------------------------------------------------------

/** A quiet sign of where a note came from (AC-7): shared, dictated, via MCP, via the API, a shortcut, nexdeck, made here. Never the
 * inbox's tray, which would only repeat the page. */
export function OriginIcon({ origin }: { origin: string }) {
  const kind = origin.split(':')[0]
  const Icon = !origin
    ? PenLine
    : kind === 'share'
      ? Share2
      : kind === 'dictation'
        ? Mic
        : kind === 'mcp'
          ? Plug
          : kind === 'api'
            ? Braces
            : kind === 'shortcut'
              ? Zap
              : kind === 'nexdeck'
                ? LayoutGrid
                : StickyNote
  return <Icon aria-hidden className="h-4 w-4 text-mist-500" strokeWidth={2} data-testid="inbox-origin-icon" data-origin={origin ? kind : 'here'} />
}

/**
 * The inbox: a list like every other (`NoteList`: the same head, "Ansicht", the four looks), whose notes say where they
 * came from (AC-7: a quiet sign before a title without a symbol, the words where other lists name the folder) and
 * carry "Einsortieren" (AC-14) and, while the title wants a look, "Titel ok". Its own empty state (EC-6).
 */
export function InboxPage() {
  const { t } = useTranslation()
  const tree = useFolders()
  const actions = useFolderActions()
  const { newNote } = useNoteActions()
  const [problem, setProblem] = useState('')
  const padding = useListPadding()
  useListTitle(t('folders.inbox.name'))
  const inboxId = tree.inbox?.id ?? ''

  const decorate = useCallback(
    (item: ListItem): ItemDecor => {
      const sortIn: ItemAction = {
        key: 'sort-in',
        label: t('folders.inbox.sortIn'),
        icon: FolderInput,
        testId: 'inbox-sort-in',
        onAct: (note) =>
          actions.moveNotes([note.id], inboxId || null, { title: note.title || t('notes.untitled'), icon: note.icon, color: note.color, sortIn: true }),
      }
      const titleOk: ItemAction = {
        key: 'title-ok',
        label: t('notes.titleOk'),
        icon: CheckCheck,
        testId: 'inbox-title-ok',
        onAct: (note) =>
          void notesApi
            .titleOk(note.id)
            .then(() => notesChanged())
            .catch((error) => setProblem(problemText(error))),
      }
      return {
        mark: <OriginIcon origin={item.origin ?? ''} />,
        folder: { name: originText(item.origin ?? '', t) },
        actions: item.title_check && !item.locked ? [titleOk, sortIn] : [sortIn],
      }
    },
    [actions, inboxId, t],
  )

  const icon = (
    <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[8px] bg-ink-800">
      <Inbox aria-hidden className="h-[17px] w-[17px] text-mist-300" strokeWidth={2} />
    </span>
  )
  const empty = (
    <div data-testid="inbox-empty" className="flex min-h-[360px] flex-col items-center justify-center gap-3 rounded-[16px] border border-dashed border-ink-600 p-6 text-center">
      <LogoMark size={44} />
      <p className="text-lg font-semibold">{t('folders.inbox.emptyTitle')}</p>
      <p className="max-w-md text-sm leading-relaxed text-mist-500">{t('folders.inbox.emptyText')}</p>
    </div>
  )

  return (
    <div className={'flex min-h-full flex-col gap-3 ' + padding} data-testid="inbox-page">
      <PhoneBack to="/folders" label={t('folders.section')} />
      {newNote && tree.inbox && <PhoneNewNote onClick={() => newNote(tree.inbox!.id)} label={t('folders.page.newNote', { name: t('folders.inbox.name') })} />}
      {problem && <p className="text-sm text-bad-500">{problem}</p>}
      {inboxId && (
        <NoteList
          folderId={inboxId}
          heading={t('folders.inbox.name')}
          icon={icon}
          intro={<p className="px-1 text-[13px] text-mist-400">{t('folders.inbox.text')}</p>}
          empty={empty}
          hrefFor={(id) => hrefIn('/inbox', id)}
          decorate={decorate}
        />
      )}
      {(tree.inbox?.count ?? 0) > 0 && <p className="px-1 text-[12.5px] text-mist-500">{t('folders.inbox.tip')}</p>}
      {actions.node}
    </div>
  )
}

// ---- All folders, the phone's way ------------------------------------------------------------------------------------

export function FoldersPage() {
  const { t } = useTranslation()
  const tree = useFolders()
  const open = useOpenFolders()
  const actions = useFolderActions()
  const { newNote } = useNoteActions()
  const [menu, setMenu] = useState<{ folder: Folder; anchor: HTMLElement } | null>(null)
  useListTitle(t('folders.section'))
  const rows = flatten(tree, open)
  return (
    <div className="flex min-h-full flex-col" data-testid="folders-page">
      <div className="flex-1 space-y-3.5 px-4 pt-5 pb-4">
        <h1 className="text-[26px] font-bold tracking-tight">{t('folders.section')}</h1>
        <div className="nn-card overflow-hidden rounded-[14px]">
          <Link to="/inbox" className="flex min-h-[50px] items-center justify-between border-b border-ink-800 px-3.5 text-base hover:bg-ink-800">
            <span className="flex items-center gap-2.5">
              <Inbox aria-hidden className="h-4 w-4 text-mist-500" />
              {t('folders.inbox.name')}
            </span>
            <span className="text-[15px] text-mist-500">{tree.inbox?.count ?? ''} ›</span>
          </Link>
          {/* The places of the drawing "Handy-Ordner" (NOTES-23 AC-1): all notes. What others shared is a smart folder
              now (NOTES-7 "Mit mir geteilt"), in the section "Intelligent" below the folders, as in the sidebar. */}
          <Link to="/" className="flex min-h-[50px] items-center justify-between px-3.5 text-base hover:bg-ink-800" data-testid="folders-all">
            <span className="flex items-center gap-2.5">
              <NotebookText aria-hidden className="h-4 w-4 text-mist-500" />
              {t('notes.all')}
            </span>
            <span className="text-[15px] text-mist-500">›</span>
          </Link>
        </div>
        <p className="px-1 text-xs font-semibold tracking-[0.06em] text-mist-500 uppercase">{t('folders.section')}</p>
        {rows.length > 0 && (
          <div className="nn-card overflow-hidden rounded-[14px]">
            {rows.map(({ folder, depth }) => {
              const hasChildren = (tree.children.get(folder.id) ?? []).length > 0
              const isOpen = open.has(folder.id)
              return (
                <div key={folder.id} className="flex min-h-[50px] items-center border-b border-ink-800 last:border-b-0" style={{ paddingLeft: 6 + Math.min(depth, 8) * 18 }}>
                  {hasChildren ? (
                    <button type="button" aria-label={isOpen ? t('folders.collapse') : t('folders.expand')} onClick={() => setFolderOpen(folder.id, !isOpen)} className="flex h-11 w-8 shrink-0 items-center justify-center text-mist-500">
                      {isOpen ? <ChevronDown aria-hidden className="h-4 w-4" /> : <ChevronRight aria-hidden className="h-4 w-4" />}
                    </button>
                  ) : (
                    <span aria-hidden className="w-8 shrink-0" />
                  )}
                  <Link to={`/folder/${folder.id}`} className="flex min-h-[50px] min-w-0 flex-1 items-center justify-between gap-2 pr-1 text-base">
                    <span className="flex min-w-0 items-center gap-2.5">
                      <FolderMark folder={folder} size={16} />
                      <span className="truncate" title={folder.name}>
                        {folder.name}
                      </span>
                    </span>
                    <span className="shrink-0 text-[15px] text-mist-500">{folder.count} ›</span>
                  </Link>
                  <button type="button" aria-label={t('folders.menu.label', { name: folder.name })} onClick={(event) => setMenu({ folder, anchor: event.currentTarget })} className="flex h-11 w-10 shrink-0 items-center justify-center text-mist-500">
                    <MoreHorizontal aria-hidden className="h-4 w-4" />
                  </button>
                </div>
              )
            })}
          </div>
        )}
        {tree.status === 'ready' && rows.length === 0 && <p className="px-1 text-sm text-mist-500">{t('folders.empty')}</p>}
        {PHONE_FOLDER_SECTIONS.map((section) => (
          <div key={section.key}>{section.render()}</div>
        ))}
      </div>
      <div className="sticky bottom-0 flex items-center justify-between border-t border-ink-700 bg-ink-900 px-4 pt-3 pb-7">
        <button type="button" onClick={() => actions.create(null)} className="h-11 px-1.5 text-[15px] text-accent-400">
          {t('folders.newFolder')}
        </button>
        {newNote && tree.inbox && (
          <button type="button" aria-label={t('folders.page.newNote', { name: t('folders.inbox.name') })} onClick={() => newNote(tree.inbox!.id)} className="flex h-[52px] w-[52px] items-center justify-center rounded-2xl bg-accent-500 text-on-accent">
            <Plus aria-hidden className="h-[22px] w-[22px]" strokeWidth={2.6} />
          </button>
        )}
      </div>
      {menu && <FolderMenu folder={menu.folder} anchor={menu.anchor} onClose={() => setMenu(null)} onAction={(action) => actions.act(action, menu.folder)} />}
      {actions.node}
    </div>
  )
}
