/** All folder dialogs for one place (the sidebar, a folder page, the phone's list): it renders `node` and calls the
 * actions. */
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router-dom'

import { foldersApi, type Folder } from './api'
import { MoveDialog, NameDialog, NewFolderDialog, StyleDialog, TrashDialog, type MoveWhat } from './dialogs'
import type { MenuAction } from './FolderMenu'
import { refreshFolders, revealFolder, setFolderOpen } from './store'

// ---- All of them for one place ---------------------------------------------------------------------------------------

type Open =
  | { kind: 'create'; parentId: string | null }
  | { kind: 'rename'; folder: Folder }
  | { kind: 'style'; folder: Folder }
  | { kind: 'move'; what: MoveWhat; onMoved?: (target: string | null) => void }
  | { kind: 'trash'; folder: Folder }
  | null

export function useFolderActions() {
  const { t } = useTranslation()
  const [open, setOpen] = useState<Open>(null)
  const navigate = useNavigate()
  const location = useLocation()
  const close = () => setOpen(null)

  const act = (action: MenuAction, folder: Folder) => {
    if (action === 'newSubfolder') setOpen({ kind: 'create', parentId: folder.id })
    else if (action === 'rename') setOpen({ kind: 'rename', folder })
    else if (action === 'style') setOpen({ kind: 'style', folder })
    else if (action === 'move') setOpen({ kind: 'move', what: { folderId: folder.id } })
    else setOpen({ kind: 'trash', folder })
  }

  /** The folder that was open went to the trash (it or one above it): its parent opens, or the start. */
  const trashed = (folder: Folder, inside: Set<string>) => {
    const shown = /^\/folder\/([^/]+)/.exec(location.pathname)?.[1]
    if (shown && inside.has(decodeURIComponent(shown))) navigate(folder.parent_id ? `/folder/${folder.parent_id}` : '/')
  }

  let node: ReactNode = null
  if (open?.kind === 'create')
    node = (
      <NewFolderDialog
        title={open.parentId ? t('folders.menu.newSubfolder') : t('folders.newFolder')}
        onClose={close}
        onSave={async (name, look) => {
          const made = await foldersApi.create(name, open.parentId, look)
          if (open.parentId) setFolderOpen(open.parentId, true)
          await refreshFolders()
          revealFolder(made.id)
        }}
      />
    )
  else if (open?.kind === 'rename')
    node = (
      <NameDialog
        title={t('folders.menu.rename')}
        initial={open.folder.name}
        onClose={close}
        onSave={async (name) => {
          await foldersApi.change(open.folder.id, { name })
          await refreshFolders()
        }}
      />
    )
  else if (open?.kind === 'style') node = <StyleDialog folder={open.folder} onClose={close} />
  else if (open?.kind === 'move') node = <MoveDialog what={open.what} onClose={close} onMoved={open.onMoved} />
  else if (open?.kind === 'trash') node = <TrashDialog folder={open.folder} onClose={close} onTrashed={trashed} />

  return {
    node,
    act,
    create: (parentId: string | null) => setOpen({ kind: 'create', parentId }),
    moveNotes: (noteIds: string[], from: string | null, options: { title?: string; icon?: string; color?: string; sortIn?: boolean; onMoved?: (target: string | null) => void } = {}) =>
      setOpen({ kind: 'move', what: { noteIds, from, noteTitle: options.title, noteIcon: options.icon, noteColor: options.color, sortIn: options.sortIn }, onMoved: options.onMoved }),
  }
}

