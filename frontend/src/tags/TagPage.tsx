/**
 * The page of one tag (drawing "N5-Schlagwort", NOTES-5 AC-2, AC-3): the tag with how many notes have it and whose,
 * every such note, own and shared, with its folder (or who shared it) and its date; renaming, deleting, and "Als
 * intelligenten Ordner sichern" once smart folders are there (AC-6).
 *
 * Its own list, not the general `NoteList`: the rows say where a note lies or who shared it, which only this page
 * knows (`GET /api/tags/<tag>`).
 *
 * `/tags` lists every tag, for when the sidebar shows only the first twenty (EC-5).
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { problemText } from '../lib/errors'
import { useListPadding, useListTitle } from '../notes/listPlace'
import { NOTES_CHANGED_EVENT } from '../notes/api'
import { tryLeave } from '../notes/context'
import { listDate } from '../notes/listDate'
import { noteHref } from '../notes/newNote'
import { tagsApi, type TagNote, type TagPage as Page } from './api'
import { smartFolderSaver, tagCondition } from './actions'
import { DeleteDialog, RenameDialog } from './dialogs'
import { tagHref } from './rules'
import { refreshTags, TAGS_CHANGED_EVENT, tagsChanged, useTags } from './store'

function useTagPage(name: string) {
  const [page, setPage] = useState<Page | null>(null)
  const [problem, setProblem] = useState('')
  const load = useCallback(() => {
    tagsApi
      .page(name)
      .then((found) => {
        setPage(found)
        setProblem('')
      })
      .catch((error) => setProblem(problemText(error)))
  }, [name])
  useEffect(() => {
    load()
    window.addEventListener(NOTES_CHANGED_EVENT, load)
    window.addEventListener(TAGS_CHANGED_EVENT, load)
    window.addEventListener('focus', load)
    return () => {
      window.removeEventListener(NOTES_CHANGED_EVENT, load)
      window.removeEventListener(TAGS_CHANGED_EVENT, load)
      window.removeEventListener('focus', load)
    }
  }, [load])
  return { page, problem, load }
}

function where(note: TagNote, t: (key: string, values?: Record<string, unknown>) => string): string {
  if (!note.mine) return t('tags.from', { name: note.owner?.name ?? '' })
  if (!note.folder || note.folder.inbox) return t('notes.inbox')
  return note.folder.name
}

export function TagPage() {
  const { t, i18n } = useTranslation()
  const { tag = '' } = useParams()
  const navigate = useNavigate()
  const { page, problem } = useTagPage(tag)
  const [dialog, setDialog] = useState<'rename' | 'delete' | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveProblem, setSaveProblem] = useState('')
  const label = page?.label ?? tag
  const padding = useListPadding()
  useListTitle(`#${label}`)
  const saver = smartFolderSaver()

  const others = page?.others ?? []
  const shared = others.reduce((sum, other) => sum + other.count, 0)

  const saveSmart = async () => {
    if (!saver || !page || saving) return
    setSaving(true)
    try {
      const href = await saver(tagCondition(page.key, page.label), `#${page.label}`)
      navigate(href)
    } catch (error) {
      setSaveProblem(problemText(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={'flex min-h-full flex-col gap-4 ' + padding} data-testid="tag-page">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="m-0 min-w-0 truncate text-2xl font-bold text-accent-400">#{label}</h1>
        {page && (
          <span className="text-[13px] text-mist-500" data-testid="tag-count">
            {t('tags.countNotes', { count: page.count })}
            {shared > 0 && t('tags.ofWhich', { count: shared, names: others.map((other) => other.name).join(', ') })}
          </span>
        )}
        {page && page.count > 0 && (
          <span className="flex flex-wrap gap-2 md:ml-auto">
            <button type="button" className="nn-btn h-9 border border-accent-500 bg-accent-wash px-3 text-[13px] text-accent-400 hover:bg-accent-500/25" onClick={() => setDialog('rename')} disabled={page.mine === 0}>
              {t('tags.rename')}
            </button>
            <button type="button" className="nn-btn nn-btn-ghost h-9 px-3 text-[13px] font-normal" onClick={() => setDialog('delete')} disabled={page.mine === 0}>
              {t('tags.delete')}
            </button>
            {saver && (
              <button type="button" className="nn-btn nn-btn-ghost h-9 px-3 text-[13px] font-normal" onClick={() => void saveSmart()} disabled={saving} data-testid="tag-smart">
                {t('tags.saveSmart')}
              </button>
            )}
          </span>
        )}
      </div>
      {problem && <p className="text-sm text-bad-500">{problem}</p>}
      {saveProblem && <p className="text-sm text-bad-500">{saveProblem}</p>}
      {page && page.count === 0 && <p className="py-6 text-sm text-mist-500">{t('tags.empty')}</p>}
      <ul className="flex max-w-[880px] flex-col">
        {(page?.notes ?? []).map((note) => (
          <li key={note.id}>
            <Link
              to={noteHref(note.id)}
              onClick={(event) => {
                if (event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) return
                event.preventDefault()
                const to = noteHref(note.id)
                tryLeave(() => navigate(to), to)
              }}
              data-testid="tag-note"
              className="flex justify-between gap-3.5 border-b border-ink-800 px-2.5 py-3 hover:bg-ink-850"
            >
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-[14.5px] font-semibold text-mist-100">{note.title || t('notes.untitled')}</span>
                {note.preview && <span className="truncate text-[12.5px] text-mist-500">{note.preview}</span>}
              </span>
              <span className="shrink-0 text-[12.5px] whitespace-nowrap text-mist-500" data-testid="tag-note-where">
                {where(note, t)}
                {note.updated_at && ` · ${listDate(note.updated_at, i18n.language)}`}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {page && dialog === 'rename' && (
        <RenameDialog
          page={page}
          onClose={() => setDialog(null)}
          onDone={(result) => {
            setDialog(null)
            tagsChanged()
            void refreshTags()
            navigate(tagHref(result.label), { replace: true })
          }}
        />
      )}
      {page && dialog === 'delete' && (
        <DeleteDialog
          page={page}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null)
            tagsChanged()
            void refreshTags()
            navigate('/tags', { replace: true })
          }}
        />
      )}
    </div>
  )
}

/** Every tag, the most frequent first (EC-5: what the sidebar leaves out). */
export function AllTagsPage() {
  const { t } = useTranslation()
  const { tags, status } = useTags()
  const padding = useListPadding()
  useListTitle(t('tags.allTitle'))
  return (
    <div className={'flex min-h-full flex-col gap-4 ' + padding} data-testid="all-tags">
      <h1 className="m-0 text-2xl font-bold text-mist-100">{t('tags.allTitle')}</h1>
      {status === 'failed' && <p className="text-sm text-bad-500">{t('tags.failed')}</p>}
      {status === 'ready' && tags.length === 0 && <p className="text-sm text-mist-500">{t('tags.none')}</p>}
      <ul className="flex max-w-[880px] flex-wrap gap-2">
        {tags.map((tag) => (
          <li key={tag.key}>
            <Link to={tagHref(tag.label)} className="flex items-center gap-2 rounded-md bg-ink-800 px-2.5 py-1 text-[13px] text-accent-400 hover:bg-ink-700" data-testid="all-tags-tag">
              #{tag.label}
              <span className="text-mist-500">{tag.count}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
