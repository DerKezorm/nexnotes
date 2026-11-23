/**
 * Sharing (NOTES-13) docks onto the frame (`extensions.ts`): its pages, the read links in "Mein Konto", and the question
 * before a note leaves a shared folder (EC-2). "Mit mir geteilt" is a fixed place: the blue tile at the top of the
 * sidebar and of the phone's page "Ordner" (`folders/QuickTiles.tsx`, NOTES-4 AC-16) leads to the page `/shared`, and so
 * does a smart folder with the condition "Geteilt: mit mir geteilt".
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
