/**
 * A smart folder opened (NOTES-7 AC-4): a list of the notes' workspace (`/smart/<id>`, the note beside it as `?note=`)
 * that always shows what fits now, as rows or tiles like any folder, its view kept on the server for every device.
 * Above it "Bearbeiten" and "Löschen" (AC-6: deleting asks once and goes without the trash; the notes stay). A
 * condition that points nowhere is named with the way to edit it (EC-1); when nothing fits, the list says so and shows
 * the conditions (EC-2).
 *
 * "Neue Notiz" on this page goes into the inbox: a smart folder is no place (NOTES-4 AC-9, `folderOfList`).
 *
 * A smart folder with the condition "Anhang" offers a third view beside list and tiles: "Anhänge", the gallery of
 * its notes' attachments (`attachments/GalleryPage.tsx`); the preset "Anhänge" opens in it. One with "Geteilt: mit
 * mir geteilt" leads to the page "Mit mir geteilt" (`/shared`: owners, rights, leaving, what went).
 */
import { Filter, MoreHorizontal, Pencil, Trash2, Users } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'

import { ApiError } from '../api/client'
import { Gallery, type GalleryLoad } from '../attachments/GalleryPage'
import type { GalleryItem } from '../attachments/api'
import { Menu } from '../components/Menu'
import { useListPadding, useListTitle } from '../notes/listPlace'
import { NoteList } from '../notes/NoteList'
import { hrefIn } from '../notes/workspace'
import type { ListMode } from '../notes/list/api'
import type { ListSource } from '../notes/list/useNoteList'
import { PhoneListWays } from '../pwa/phone'
import { smartApi, type Broken, type SmartAnswer, type SmartFolder } from './api'
import { asksAttachments, asksSharedWithMe, describe, smartName } from './conditions'
import { useFolderName } from './folderName'
import { SmartDeleteDialog, SmartMark } from './SmartMenu'
import { useSmartFolders } from './store'

/** The conditions as sentences, joined by "and" or "or" (the empty state, EC-2). */
export function ConditionList({ folder }: { folder: SmartFolder }) {
  const { t, i18n } = useTranslation()
  const folderName = useFolderName()
  return (
    <div className="flex flex-col items-center gap-1.5">
      <p className="text-[13px] text-mist-500">{t(folder.match === 'any' ? 'smart.matchAnySays' : 'smart.matchAllSays')}</p>
      <ul className="flex flex-wrap justify-center gap-1.5" data-testid="smart-conditions">
        {folder.conditions.map((condition, index) => (
          <li key={index} className="rounded-md bg-ink-800 px-2 py-[3px] text-[12.5px] text-mist-100" data-testid="smart-condition">
            {describe(condition, t, i18n.language, folderName)}
          </li>
        ))}
      </ul>
    </div>
  )
}

const WITH_GALLERY: readonly ListMode[] = ['list', 'gallery']

/** The attachments of the smart folder's notes; an entry opens its note beside the list, at the attachment. Read anew
 * with every new answer of the list (`read`): a note that came in with its attachment shows it at once. */
function SmartGallery({ id, read }: { id: string; read: number }) {
  const [params] = useSearchParams()
  const load = useCallback<GalleryLoad>((query) => smartApi.gallery(id, query), [id])
  const hrefFor = useCallback(
    (item: GalleryItem) => {
      const query = new URLSearchParams(params)
      query.delete('note')
      query.set('attachment', item.id)
      return hrefIn(`/smart/${encodeURIComponent(id)}?${query.toString()}`, item.note.id)
    },
    [id, params],
  )
  return <Gallery load={load} sourceKey={`${id}:${read}`} embedded hrefFor={hrefFor} />
}

function BrokenNote({ broken, folderId }: { broken: Broken[]; folderId: string }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-[12px] border border-warn-500/50 bg-warn-500/10 px-3.5 py-2.5 text-[13px] text-mist-100" role="status" data-testid="smart-broken">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        {broken.map((item) => (
          <span key={item.index} data-testid="smart-broken-item">
            {item.kind === 'folder' ? t('smart.broken.folder', { name: item.name || t('smart.broken.unnamed') }) : t('smart.broken.tag', { tag: `#${item.name}` })}
          </span>
        ))}
      </span>
      <Link to={`/smart/${encodeURIComponent(folderId)}/edit`} className="nn-btn h-8 border border-warn-500/60 px-3 text-[13px]" data-testid="smart-broken-edit">
        {t('smart.edit')}
      </Link>
    </div>
  )
}

export function SmartFolderPage() {
  const { t } = useTranslation()
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const padding = useListPadding()
  const { folders } = useSmartFolders()
  const [answer, setAnswer] = useState<SmartAnswer | null>(null)
  // How often the list read its notes; the gallery follows (its notes changed, so may their attachments).
  const [reads, setReads] = useState(0)
  const [missing, setMissing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [more, setMore] = useState<HTMLElement | null>(null)
  const known = folders.find((folder) => folder.id === id) ?? null
  const folder = answer?.folder.id === id ? answer.folder : known
  const name = folder ? smartName(folder, t) : ''
  const withGallery = folder ? asksAttachments(folder) : false
  useListTitle(name || t('smart.heading'))

  const source = useMemo<ListSource>(
    () => ({
      key: `smart:${id}`,
      read: () =>
        smartApi.notes(id).then(
          (found) => {
            setAnswer(found)
            setReads((count) => count + 1)
            setMissing(false)
            return found
          },
          (error: unknown) => {
            if (error instanceof ApiError && error.status === 404) setMissing(true)
            throw error
          },
        ),
      stamp: () => smartApi.stamp(id),
      saveView: (view) => smartApi.saveView(id, view),
    }),
    [id],
  )

  if (missing)
    return (
      <div className={'flex flex-col gap-3 ' + padding} data-testid="smart-missing">
        <PhoneListWays />
        <h1 className="text-2xl font-bold">{t('smart.missingTitle')}</h1>
        <p className="text-sm text-mist-500">{t('smart.missingText')}</p>
      </div>
    )

  const empty = folder && (
    <div data-testid="smart-empty" className="flex min-h-[260px] flex-col items-center justify-center gap-3.5 rounded-[16px] border border-dashed border-ink-600 p-6 text-center">
      <Filter aria-hidden className="h-11 w-11 text-accent-400" strokeWidth={1.4} />
      <p className="text-lg font-semibold">{t('smart.emptyTitle')}</p>
      <ConditionList folder={folder} />
      <Link to={`/smart/${encodeURIComponent(id)}/edit`} className="nn-btn nn-btn-ghost h-9 px-3 text-[13px]" data-testid="smart-empty-edit">
        {t('smart.edit')}
      </Link>
    </div>
  )

  // The head every list has: "Ansicht", then the smart folder's own buttons ("…": edit, delete).
  const actions = (
    <>
      {folder && asksSharedWithMe(folder) && (
        <Link to="/shared" className="nn-btn nn-btn-ghost h-8 gap-1.5 px-2.5 text-[13px] font-normal" data-testid="smart-shared-page">
          <Users aria-hidden className="h-3.5 w-3.5" />
          {t('smart.sharedPage')}
        </Link>
      )}
      <button
        type="button"
        aria-label={t('smart.menu', { name: name || t('smart.heading') })}
        aria-haspopup="menu"
        aria-expanded={Boolean(more)}
        onClick={(event) => setMore(more ? null : event.currentTarget)}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-mist-500 hover:bg-ink-800 hover:text-mist-100"
        data-testid="smart-more"
      >
        <MoreHorizontal aria-hidden className="h-4 w-4" />
      </button>
      {more && (
        <Menu anchor={more} onClose={() => setMore(null)} label={t('smart.menu', { name: name || t('smart.heading') })} testId="smart-menu">
          <Link to={`/smart/${encodeURIComponent(id)}/edit`} role="menuitem" className="nn-menu-item" data-testid="smart-edit" onClick={() => setMore(null)}>
            <Pencil aria-hidden className="h-4 w-4" />
            {t('smart.edit')}
          </Link>
          <button
            type="button"
            role="menuitem"
            className="nn-menu-item"
            onClick={() => {
              setMore(null)
              setDeleting(true)
            }}
            disabled={!folder}
            data-testid="smart-delete-open"
          >
            <Trash2 aria-hidden className="h-4 w-4" />
            {t('smart.delete')}
          </button>
        </Menu>
      )}
    </>
  )

  return (
    <div className={'flex min-h-full flex-col gap-3 ' + padding} data-testid="smart-page">
      <PhoneListWays />
      {answer && answer.folder.id === id && answer.broken.length > 0 && <BrokenNote broken={answer.broken} folderId={id} />}
      <NoteList
        heading={name || ' '}
        icon={folder ? <SmartMark folder={folder} size={18} /> : undefined}
        actions={actions}
        source={source}
        empty={empty || undefined}
        hrefFor={(noteId) => hrefIn(`/smart/${encodeURIComponent(id)}`, noteId)}
        modes={withGallery ? WITH_GALLERY : undefined}
        gallery={withGallery ? <SmartGallery id={id} read={reads} /> : undefined}
      />
      {deleting && folder && <SmartDeleteDialog folder={folder} onClose={() => setDeleting(false)} onDeleted={() => navigate('/')} />}
    </div>
  )
}
