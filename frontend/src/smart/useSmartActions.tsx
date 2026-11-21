/** The menu of the smart folders for one place (the sidebar, the phone's page "Ordner"): it opens the menu beside a
 * row, does what was chosen and renders `node` (the menu and the question before deleting). */
import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

import type { MenuAnchor } from '../components/Menu'
import type { SmartFolder } from './api'
import { keepOrder, stepped } from './order'
import { SmartDeleteDialog, SmartMenu, type SmartAction } from './SmartMenu'

export function useSmartActions(folders: SmartFolder[], onNavigate?: () => void) {
  const navigate = useNavigate()
  const location = useLocation()
  const [menu, setMenu] = useState<{ folder: SmartFolder; anchor: MenuAnchor } | null>(null)
  const [deleting, setDeleting] = useState<SmartFolder | null>(null)
  const ids = folders.map((folder) => folder.id)

  const act = (action: SmartAction, folder: SmartFolder) => {
    if (action === 'edit') {
      onNavigate?.()
      navigate(`/smart/${encodeURIComponent(folder.id)}/edit`)
    } else if (action === 'up' || action === 'down') {
      const next = stepped(ids, folder.id, action === 'up' ? -1 : 1)
      if (next !== ids) keepOrder(next)
    } else setDeleting(folder)
  }

  // Deleting the one that is open leaves its page for the start; another one deleted leaves the page as it is.
  const deleted = (folder: SmartFolder) => {
    setDeleting(null)
    const own = `/smart/${encodeURIComponent(folder.id)}`
    if (location.pathname === own || location.pathname.startsWith(`${own}/`)) navigate('/')
  }

  const open = (folder: SmartFolder, anchor: MenuAnchor) => setMenu({ folder, anchor })
  const toggle = (folder: SmartFolder, anchor: HTMLElement) => setMenu((now) => (now?.folder.id === folder.id ? null : { folder, anchor }))
  const at = menu ? ids.indexOf(menu.folder.id) : -1

  const node = (
    <>
      {menu && (
        <SmartMenu
          folder={menu.folder}
          anchor={menu.anchor}
          first={at <= 0}
          last={at === ids.length - 1}
          onClose={() => setMenu(null)}
          onAction={(action) => act(action, menu.folder)}
        />
      )}
      {deleting && <SmartDeleteDialog folder={deleting} onClose={() => setDeleting(null)} onDeleted={() => deleted(deleting)} />}
    </>
  )
  return { open, toggle, act, openId: menu?.folder.id ?? null, node }
}
