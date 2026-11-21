/**
 * The page of one tag (drawing "N5-Schlagwort", NOTES-5 AC-2, AC-3): the tag with how many notes have it and whose,
 * every such note, own and shared, with its folder (or who shared it) and its date; renaming, deleting, and "Als
 * intelligenten Ordner sichern" once smart folders are there (AC-6), in the head's "…".
 *
 * A list like every other (`NoteList`: the same head, "Ansicht", the four looks), its notes from
 * `GET /api/tags/<tag>/notes`, sorted and grouped as the account keeps it for this tag. Where a note lies says its
 * folder (in the folder's colour) or who shared it.
 *
 * `/tags` lists every tag, for when the sidebar shows only the first twenty (EC-5).
 */
import { Hash, MoreHorizontal, Pencil, Save, Trash2 } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { Menu } from '../components/Menu'
import { colorOf } from '../folders/palette'
import { useFolders } from '../folders/store'
import { problemText } from '../lib/errors'
import { useListPadding, useListTitle } from '../notes/listPlace'
import type { ListItem } from '../notes/list/api'
import type { ItemDecor } from '../notes/list/ItemParts'
import type { ListSource } from '../notes/list/useNoteList'
import { NoteList } from '../notes/NoteList'
import { tagsApi, type TagHead } from './api'
import { smartFolderSaver, tagCondition } from './actions'
import { DeleteDialog, RenameDialog } from './dialogs'
import { tagHref } from './rules'
import { refreshTags, tagsChanged, useTags } from './store'

type T = (key: string, values?: Record<string, unknown>) => string

/** "3 Notizen, davon 1 von Lena". */
function countOf(head: TagHead, t: T): string {
  const shared = head.others.reduce((sum, other) => sum + other.count, 0)
  const whose = shared > 0 ? t('tags.ofWhich', { count: shared, names: head.others.map((other) => other.name).join(', ') }) : ''
  return t('tags.countNotes', { count: head.count }) + whose
}

export function TagPage() {
  const { t } = useTranslation()
  const { tag = '' } = useParams()
  const navigate = useNavigate()
  const tree = useFolders()
  const [head, setHead] = useState<(TagHead & { asked: string }) | null>(null)
  const [dialog, setDialog] = useState<'rename' | 'delete' | null>(null)
  const [more, setMore] = useState<HTMLElement | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveProblem, setSaveProblem] = useState('')
  // What the server said about this tag, never about the tag shown before.
  const page = head?.asked === tag ? head : null
  const label = page?.label ?? tag
  const padding = useListPadding()
  useListTitle(`#${label}`)
  const saver = smartFolderSaver()

  const source = useMemo<ListSource>(
    () => ({
      key: `tag:${tag}`,
      read: () =>
        tagsApi.notes(tag).then((found) => {
          setHead({ asked: tag, tag: found.tag, label: found.label, count: found.count, mine: found.mine, others: found.others })
          return found
        }),
      stamp: () => tagsApi.stamp(tag),
      saveView: (view) => tagsApi.saveView(tag, view),
    }),
    [tag],
  )

  // Own notes name their folder in its colour, shared ones who shared them.
  const decorate = useCallback(
    (item: ListItem): ItemDecor => {
      if (item.owner) return { folder: { name: t('tags.from', { name: item.owner.name }) } }
      if (tree.inbox?.id === item.folder_id) return { folder: { name: t('notes.inbox'), color: 'var(--color-mist-500)' } }
      const folder = tree.byId.get(item.folder_id)
      return { folder: folder ? { name: folder.name, color: colorOf(folder.color) } : null }
    },
    [t, tree],
  )

  const saveSmart = async () => {
    if (!saver || !page || saving) return
    setSaving(true)
    try {
      const href = await saver(tagCondition(page.tag, page.label), `#${page.label}`)
      navigate(href)
    } catch (error) {
      setSaveProblem(problemText(error))
    } finally {
      setSaving(false)
    }
  }

  const menuLabel = t('tags.menu', { tag: `#${label}` })
  const pick = (what: 'rename' | 'delete') => () => {
    setMore(null)
    setDialog(what)
  }
  const actions = page && page.count > 0 && (
    <>
      <button
        type="button"
        aria-label={menuLabel}
        aria-haspopup="menu"
        aria-expanded={Boolean(more)}
        onClick={(event) => setMore(more ? null : event.currentTarget)}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-mist-500 hover:bg-ink-800 hover:text-mist-100"
        data-testid="tag-more"
      >
        <MoreHorizontal aria-hidden className="h-4 w-4" />
      </button>
      {more && (
        <Menu anchor={more} onClose={() => setMore(null)} label={menuLabel} testId="tag-menu">
          <button type="button" role="menuitem" className="nn-menu-item" disabled={page.mine === 0} onClick={pick('rename')} data-testid="tag-rename-open">
            <Pencil aria-hidden className="h-4 w-4" />
            {t('tags.rename')}
          </button>
          <button type="button" role="menuitem" className="nn-menu-item" disabled={page.mine === 0} onClick={pick('delete')} data-testid="tag-delete-open">
            <Trash2 aria-hidden className="h-4 w-4" />
            {t('tags.delete')}
          </button>
          {saver && (
            <button
              type="button"
              role="menuitem"
              className="nn-menu-item"
              disabled={saving}
              data-testid="tag-smart"
              onClick={() => {
                setMore(null)
                void saveSmart()
              }}
            >
              <Save aria-hidden className="h-4 w-4" />
              {t('tags.saveSmart')}
            </button>
          )}
        </Menu>
      )}
    </>
  )

  return (
    <div className={'flex min-h-full flex-col gap-3 ' + padding} data-testid="tag-page">
      {saveProblem && <p className="text-sm text-bad-500">{saveProblem}</p>}
      <NoteList
        heading={`#${label}`}
        icon={<Hash aria-hidden className="h-[18px] w-[18px] shrink-0 text-accent-400" strokeWidth={2.2} />}
        count={page ? countOf(page, t) : ''}
        actions={actions || undefined}
        source={source}
        decorate={decorate}
        empty={
          <p className="py-6 text-sm text-mist-500" data-testid="tag-empty">
            {t('tags.empty')}
          </p>
        }
      />
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
