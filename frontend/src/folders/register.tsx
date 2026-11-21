/** The folders dock onto the frame: the inbox and the tree in the sidebar, the pages as routes (`extensions.ts`). */
import { FEATURE_ROUTES, SIDEBAR_SECTIONS } from '../extensions'
import { FolderTree, InboxEntry } from './FolderTree'
import { FolderPage, FoldersPage, InboxPage } from './pages'

SIDEBAR_SECTIONS.push({ key: 'inbox', render: () => <InboxEntry /> }, { key: 'folders', render: () => <FolderTree /> })
FEATURE_ROUTES.push(
  { path: 'folder/:id', element: <FolderPage />, list: true },
  { path: 'inbox', element: <InboxPage />, list: true },
  { path: 'folders', element: <FoldersPage />, list: true },
)
