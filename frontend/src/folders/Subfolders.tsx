/**
 * A folder's direct subfolders above its notes, as in the iPhone app (NOTES-6, change after the contract of
 * 22.11.2026): a small heading "Folders", then a row each with its symbol in its color, its name, its numbers „3 (12)“
 * and "…" with the folder's menu (the one of the sidebar, also on a right click). A click opens the subfolder. Nothing
 * at all for a folder without subfolders.
 */
import { ChevronRight, MoreHorizontal } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import type { Folder } from './api'
import { useFolderCountWords } from './countWords'
import { FolderMark } from './FolderMark'
import { FolderMenu, type MenuAction } from './FolderMenu'
import { colorOf } from './palette'
import { countLabel, useFolders } from './store'

export function Subfolders({ parentId, onAction }: { parentId: string; onAction: (action: MenuAction, folder: Folder) => void }) {
  const { t } = useTranslation()
  const tree = useFolders()
  const words = useFolderCountWords()
  const [menu, setMenu] = useState<{ folder: Folder; anchor: HTMLElement } | null>(null)
  const subfolders = (tree.children.get(parentId) ?? []).map((id) => tree.byId.get(id)).filter((folder): folder is Folder => Boolean(folder))
  if (subfolders.length === 0) return null

  return (
    <section aria-labelledby={`subfolders-${parentId}`} className="flex flex-col gap-1.5" data-testid="subfolders">
      <h2 id={`subfolders-${parentId}`} className="px-1 text-[11px] font-semibold tracking-[0.06em] text-mist-500 uppercase">
        {t('folders.section')}
      </h2>
      <ul className="nn-card overflow-hidden rounded-[12px]">
        {subfolders.map((folder) => (
          <li
            key={folder.id}
            className="flex min-h-11 items-center border-b border-ink-800 last:border-b-0"
            data-folder={folder.id}
            data-testid="subfolder"
            onContextMenu={(event) => {
              event.preventDefault()
              setMenu({ folder, anchor: event.currentTarget })
            }}
          >
            <Link
              to={`/folder/${folder.id}`}
              aria-label={`${folder.name}, ${words(folder)}`}
              className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 pr-1 pl-3 text-[14px] text-mist-100 hover:bg-ink-800"
            >
              <span
                className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[7px]"
                style={{ background: `color-mix(in srgb, ${colorOf(folder.color)} 16%, transparent)` }}
              >
                <FolderMark folder={folder} size={15} />
              </span>
              <span className="min-w-0 flex-1 truncate" title={folder.name}>
                {folder.name}
              </span>
              <span className="shrink-0 text-[13px] text-mist-500 tabular-nums" data-testid="subfolder-count">
                {countLabel(tree, folder)}
              </span>
              <ChevronRight aria-hidden className="h-3.5 w-3.5 shrink-0 text-mist-600" strokeWidth={2.4} />
            </Link>
            <button
              type="button"
              aria-label={t('folders.menu.label', { name: folder.name })}
              aria-haspopup="menu"
              onClick={(event) => setMenu({ folder, anchor: event.currentTarget })}
              className="flex h-11 w-10 shrink-0 items-center justify-center text-mist-500 hover:bg-ink-800 hover:text-mist-100"
            >
              <MoreHorizontal aria-hidden className="h-4 w-4" />
            </button>
          </li>
        ))}
      </ul>
      {menu && <FolderMenu folder={menu.folder} anchor={menu.anchor} onClose={() => setMenu(null)} onAction={(action) => onAction(action, menu.folder)} />}
    </section>
  )
}
