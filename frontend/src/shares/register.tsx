/**
 * Sharing (NOTES-13) docks onto the frame (`extensions.ts`): its pages, the read links in "Mein Konto", and the question
 * before a note leaves a shared folder (EC-2). "Mit mir geteilt" is no fixed entry of the sidebar any more but a smart
 * folder every account gets (NOTES-7, preset `shared_with_me`), which leads to the page `/shared`; the page stays at its
 * address for the phone's folders, the smart folder and links from elsewhere.
 */
import { ACCOUNT_SECTIONS, FEATURE_ROUTES, SHELL_PARTS } from '../extensions'
import { registerNoteMoveCheck } from '../folders/actions'
import { MoveQuestion } from './MoveQuestion'
import { askMoveOut } from './moveAsk'
import { ReadLinksCard } from './ReadLinksCard'
import { SharedFolderPage, SharedPage } from './SharedPage'

FEATURE_ROUTES.push({ path: 'shared', element: <SharedPage />, list: true }, { path: 'shared/folder/:id', element: <SharedFolderPage />, list: true })
ACCOUNT_SECTIONS.push({ key: 'read-links', render: () => <ReadLinksCard /> })
SHELL_PARTS.push({ key: 'share-move-question', render: () => <MoveQuestion /> })
registerNoteMoveCheck(askMoveOut)
