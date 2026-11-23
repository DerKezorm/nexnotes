/** The folders dock onto the frame: the tiles (inbox, all notes, shared with me) and the tree in the sidebar, the
 * pages as routes (`extensions.ts`). */
import { FEATURE_ROUTES, SIDEBAR_SECTIONS } from '../extensions'
import { FolderTree } from './FolderTree'
import { FolderPage, FoldersPage, InboxPage } from './pages'
import { QuickTiles } from './QuickTiles'

SIDEBAR_SECTIONS.push({ key: 'tiles', render: () => <QuickTiles /> }, { key: 'folders', render: () => <FolderTree /> })
FEATURE_ROUTES.push(
  { path: 'folder/:id', element: <FolderPage />, list: true },
  { path: 'inbox', element: <InboxPage />, list: true },
  { path: 'folders', element: <FoldersPage />, list: true },
)
