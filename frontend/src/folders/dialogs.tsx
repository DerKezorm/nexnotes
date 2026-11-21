/**
 * The dialogs of the folders: a name (new folder, new subfolder, rename), symbol and color, "Move …" with search, and
 * the question before the trash. `useFolderActions` gives a place (the sidebar, a folder page, the phone's list) all of
 * them at once; the place renders `node` and calls the actions.
 */
import { Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '../components/Dialog'
import { NoteIcon } from '../components/NoteIcon'
import { SymbolPicker } from '../components/SymbolPicker'
import { problemText } from '../lib/errors'
import { foldersApi, type Folder, type Impact } from './api'
import { FolderMark } from './FolderMark'
import { notesMoved } from './actions'
import { ColorField } from './ColorField'
import { colorOf } from './palette'
import { flatten, refreshFolders, revealFolder, setFolderOpen, subtreeOf, useFolders } from './store'
import { showNotice } from './notice'

function Problem({ text }: { text: string }) {
  if (!text) return null
  return (
    <p role="alert" className="rounded-[9px] border border-bad-500/40 bg-bad-500/10 px-3 py-2 text-sm text-bad-500">
      {text}
    </p>
  )
}

// ---- A name ----------------------------------------------------------------------------------------------------------

export function NameDialog({ title, initial, onSave, onClose }: { title: string; initial: string; onSave: (name: string) => Promise<void>; onClose: () => void }) {
  const { t } = useTranslation()
  const [name, setName] = useState(initial)
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState(false)
  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    try {
      await onSave(name)
      onClose()
    } catch (error) {
      setProblem(problemText(error))
      setBusy(false)
    }
  }
  return (
    <Dialog title={title} onClose={onClose}>
      <form onSubmit={(event) => void save(event)} className="space-y-4">
        <input
          className="nn-field"
          value={name}
          aria-label={t('folders.namePlaceholder')}
          placeholder={t('folders.namePlaceholder')}
          onChange={(event) => {
            setName(event.target.value)
            setProblem('')
          }}
          onFocus={(event) => event.target.select()}
        />
        <Problem text={problem} />
        <div className="flex justify-end gap-2">
          <button type="button" className="nn-btn nn-btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="nn-btn nn-btn-accent" disabled={busy || !name.trim()}>
            {t('common.save')}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

// ---- Symbol and color (AC-10) ----------------------------------------------------------------------------------------

type Look = { icon: string; color: string }

/** The color and the symbol of a folder, for the dialog "Symbol and color" and for a new folder. */
export function LookFields({ look, onChange }: { look: Look; onChange: (change: Partial<Look>) => void }) {
  const { t } = useTranslation()
  return (
    <>
      <ColorField value={look.color} onChange={(color) => onChange({ color })} />
      <fieldset>
        <legend className="mb-2 text-xs font-semibold tracking-wide text-mist-500 uppercase">{t('folders.style.icon')}</legend>
        <SymbolPicker value={look.icon} onChange={(icon) => onChange({ icon })} color={look.color ? colorOf(look.color) : undefined} />
        <button type="button" aria-pressed={!look.icon} onClick={() => onChange({ icon: '' })} className="nn-btn-quiet mt-2 text-sm">
          {t('folders.style.noIcon')}
        </button>
      </fieldset>
    </>
  )
}

/** A new folder (AC-1): its name, and right away its symbol and color (AC-10). */
export function NewFolderDialog({ title, onSave, onClose }: { title: string; onSave: (name: string, look: Look) => Promise<void>; onClose: () => void }) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [look, setLook] = useState<Look>({ icon: '', color: '' })
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState(false)
  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    if (busy || !name.trim()) return
    setBusy(true)
    try {
      await onSave(name, look)
      onClose()
    } catch (error) {
      setProblem(problemText(error))
      setBusy(false)
    }
  }
  return (
    <Dialog title={title} onClose={onClose}>
      <form onSubmit={(event) => void save(event)} className="space-y-4" data-testid="new-folder">
        <div className="flex items-center gap-2.5">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[9px] border border-ink-700" data-testid="look-preview">
            <FolderMark folder={look.icon ? look : { ...look, icon: 'folder' }} size={20} />
          </span>
          <input
            className="nn-field"
            value={name}
            aria-label={t('folders.namePlaceholder')}
            placeholder={t('folders.namePlaceholder')}
            onChange={(event) => {
              setName(event.target.value)
              setProblem('')
            }}
          />
        </div>
        <LookFields look={look} onChange={(change) => setLook({ ...look, ...change })} />
        <Problem text={problem} />
        <div className="flex justify-end gap-2">
          <button type="button" className="nn-btn nn-btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="nn-btn nn-btn-accent" disabled={busy || !name.trim()}>
            {t('folders.create')}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

export function StyleDialog({ folder, onClose }: { folder: Folder; onClose: () => void }) {
  const { t } = useTranslation()
  const [look, setLook] = useState({ icon: folder.icon, color: folder.color })
  const [problem, setProblem] = useState('')
  const choose = async (change: { icon?: string; color?: string }) => {
    const before = look
    setLook({ ...look, ...change })
    try {
      await foldersApi.change(folder.id, change)
      void refreshFolders()
    } catch (error) {
      setLook(before)
      setProblem(problemText(error))
    }
  }
  return (
    <Dialog title={t('folders.style.title')} onClose={onClose}>
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm text-mist-300" data-testid="look-preview">
          <FolderMark folder={look} size={18} />
          <span className="truncate">{folder.name}</span>
        </div>
        <LookFields look={look} onChange={(change) => void choose(change)} />
        <Problem text={problem} />
        <div className="flex justify-end">
          <button type="button" className="nn-btn nn-btn-accent" onClick={onClose}>
            {t('common.done')}
          </button>
        </div>
      </div>
    </Dialog>
  )
}

// ---- Move … (AC-3, AC-14, EC-1) --------------------------------------------------------------------------------------

export type MoveWhat = { folderId?: string; noteIds?: string[]; noteTitle?: string; noteIcon?: string; noteColor?: string; from?: string | null; sortIn?: boolean }

type Target = { id: string | null; name: string; depth: number; folder?: Folder; off?: string; hint?: string; inbox?: boolean }

export function MoveDialog({ what, onClose, onMoved }: { what: MoveWhat; onClose: () => void; onMoved?: (target: string | null) => void }) {
  const { t } = useTranslation()
  const tree = useFolders()
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState<string | null | undefined>(undefined)
  const [impact, setImpact] = useState<Impact | null>(null)
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState(false)
  const list = useRef<HTMLDivElement>(null)
  const folder = what.folderId ? tree.byId.get(what.folderId) : undefined
  const notes = what.noteIds ?? []

  useEffect(() => {
    if (what.folderId) void foldersApi.impact(what.folderId).then(setImpact, () => undefined)
  }, [what.folderId])

  const targets = useMemo<Target[]>(() => {
    const inside = folder ? subtreeOf(tree, folder.id) : new Set<string>()
    const here = folder ? folder.parent_id : (what.from ?? null)
    const all: Target[] = []
    if (folder) all.push({ id: null, name: t('folders.move.top'), depth: 0, hint: here === null ? t('folders.move.here') : undefined })
    else if (tree.inbox) all.push({ id: tree.inbox.id, name: t('folders.inbox.name'), depth: 0, inbox: true, hint: here === tree.inbox.id ? t('folders.move.here') : undefined })
    for (const { folder: row, depth } of flatten(tree, null)) {
      const entry: Target = { id: row.id, name: row.name, depth, folder: row }
      if (folder && row.id === folder.id) entry.off = t('folders.move.itself')
      else if (inside.has(row.id)) entry.off = t('folders.move.inside')
      else if (row.id === here) entry.hint = t('folders.move.here')
      all.push(entry)
    }
    const needle = query.trim().toLocaleLowerCase()
    if (!needle) return all
    // A match shows with the folders above it, so that two folders of the same name can be told apart.
    const keep = new Set<string | null>()
    for (const entry of all) {
      if (!entry.name.toLocaleLowerCase().includes(needle)) continue
      keep.add(entry.id)
      let parent = entry.folder?.parent_id ?? null
      while (parent) {
        keep.add(parent)
        parent = tree.byId.get(parent)?.parent_id ?? null
      }
    }
    return all.filter((entry) => keep.has(entry.id))
  }, [tree, folder, what.from, query, t])

  const usable = targets.filter((entry) => !entry.off)
  const picked = chosen === undefined ? undefined : targets.find((entry) => entry.id === chosen && !entry.off)

  const step = (by: number) => {
    if (!usable.length) return
    const at = usable.findIndex((entry) => entry.id === chosen)
    const next = usable[Math.max(0, Math.min(usable.length - 1, at < 0 ? (by > 0 ? 0 : usable.length - 1) : at + by))]
    setChosen(next.id)
    list.current?.querySelector(`[data-target="${next.id ?? 'top'}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }

  const move = async () => {
    if (!picked || busy) return
    setBusy(true)
    setProblem('')
    try {
      if (folder) await foldersApi.move(picked.id, [folder.id])
      else await foldersApi.move(picked.id, [], notes)
      if (picked.id) revealFolder(picked.id)
      if (folder && picked.id) setFolderOpen(picked.id, true)
      await refreshFolders()
      if (notes.length && picked.id) notesMoved(notes, picked.id)
      onMoved?.(picked.id)
      onClose()
    } catch (error) {
      setProblem(problemText(error))
      setBusy(false)
    }
  }

  const title = folder
    ? t('folders.move.title', { name: folder.name })
    : what.sortIn
      ? t('folders.move.sortIn', { name: what.noteTitle ?? '' })
      : t('folders.move.notes', { count: notes.length, name: what.noteTitle ?? '' })

  return (
    <Dialog title={title} onClose={onClose} medium lead={!folder && what.noteIcon ? <NoteIcon icon={what.noteIcon} color={what.noteColor} size={16} /> : undefined}>
      <div className="space-y-3">
        {folder && impact && (
          <p className="text-sm text-mist-400">
            {t('folders.move.with', { folders: t('folders.count.subfolders', { count: impact.folders }), notes: t('folders.count.notes', { count: impact.notes }) })}
          </p>
        )}
        <label className="flex h-10 items-center gap-2 rounded-[9px] border border-edge bg-ink-900 px-3 focus-within:border-accent-700">
          <Search aria-hidden className="h-4 w-4 text-mist-500" />
          <input
            className="min-w-0 flex-1 bg-transparent text-sm text-mist-100 outline-none placeholder:text-mist-600"
            placeholder={t('folders.move.search')}
            aria-label={t('folders.move.search')}
            aria-controls="folder-move-targets"
            aria-activedescendant={picked ? `folder-target-${picked.id ?? 'top'}` : undefined}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') step(1)
              else if (event.key === 'ArrowUp') step(-1)
              else if (event.key === 'Enter') void move()
              else return
              event.preventDefault()
            }}
          />
        </label>
        <div ref={list} id="folder-move-targets" role="listbox" aria-label={t('folders.move.targets')} className="nn-scroll max-h-80 space-y-0.5 overflow-y-auto">
          {targets.map((entry) => {
            const on = picked !== undefined && entry.id === picked.id
            return (
              <div
                key={entry.id ?? 'top'}
                id={`folder-target-${entry.id ?? 'top'}`}
                data-target={entry.id ?? 'top'}
                role="option"
                aria-selected={on}
                aria-disabled={entry.off ? true : undefined}
                title={entry.off ? t('folders.move.notInside') : entry.name}
                onClick={() => !entry.off && setChosen(entry.id)}
                onDoubleClick={() => !entry.off && void move()}
                className={
                  'flex h-9 cursor-pointer items-center justify-between gap-2 rounded-lg pr-2.5 text-sm ' +
                  (entry.off ? 'cursor-not-allowed text-mist-600' : on ? 'nn-chosen' : 'text-mist-100 hover:bg-ink-800')
                }
                style={{ paddingLeft: 10 + Math.min(entry.depth, 8) * 18 }}
              >
                <span className={'flex min-w-0 items-center gap-2 ' + (entry.off ? 'opacity-50' : '')}>
                  {entry.folder ? <FolderMark folder={entry.folder} /> : <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-[3px] bg-mist-500" />}
                  <span className="truncate">{entry.name}</span>
                </span>
                <span className="shrink-0 text-xs text-mist-500">{entry.off ?? entry.hint ?? ''}</span>
              </div>
            )
          })}
          {targets.length === 0 && <p className="px-2 py-3 text-sm text-mist-500">{t('folders.move.none')}</p>}
        </div>
        <Problem text={problem} />
        <div className="flex justify-end gap-2">
          <button type="button" className="nn-btn nn-btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="nn-btn nn-btn-accent" disabled={!picked || busy} onClick={() => void move()}>
            {picked ? t('folders.move.to', { name: picked.name }) : t('folders.move.choose')}
          </button>
        </div>
      </div>
    </Dialog>
  )
}

// ---- Into the trash (AC-5) -------------------------------------------------------------------------------------------

export function TrashDialog({ folder, onClose, onTrashed }: { folder: Folder; onClose: () => void; onTrashed: (folder: Folder, inside: Set<string>) => void }) {
  const { t } = useTranslation()
  const tree = useFolders()
  const [impact, setImpact] = useState<Impact | null>(null)
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    foldersApi.impact(folder.id).then(setImpact, (error) => setProblem(problemText(error)))
  }, [folder.id])
  const confirm = async () => {
    if (busy) return
    setBusy(true)
    const inside = subtreeOf(tree, folder.id)
    try {
      const done = await foldersApi.trash(folder.id)
      await refreshFolders()
      onClose()
      onTrashed(folder, inside)
      showNotice({
        text: t('folders.trash.done', { name: folder.name, notes: t('folders.count.notes', { count: done.notes }) }),
        undo: async () => {
          await foldersApi.restore(folder.id)
          await refreshFolders()
          return t('folders.trash.undone', { name: folder.name })
        },
      })
    } catch (error) {
      setProblem(problemText(error))
      setBusy(false)
    }
  }
  const empty = impact && impact.notes === 0 && impact.folders === 0
  return (
    <Dialog title={t('folders.trash.title', { name: folder.name })} onClose={onClose}>
      <div className="space-y-4 text-sm text-mist-300">
        {impact && (
          <p data-testid="trash-question">
            {empty
              ? t('folders.trash.empty')
              : t('folders.trash.with', { folders: t('folders.count.subfolders', { count: impact.folders }), notes: t('folders.count.notes', { count: impact.notes }) })}{' '}
            {t('folders.trash.keep', { count: impact.trash_days })}
          </p>
        )}
        <Problem text={problem} />
        <div className="flex justify-end gap-2">
          <button type="button" className="nn-btn nn-btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="nn-btn nn-btn-danger" disabled={!impact || busy} onClick={() => void confirm()}>
            {t('folders.trash.button')}
          </button>
        </div>
      </div>
    </Dialog>
  )
}
