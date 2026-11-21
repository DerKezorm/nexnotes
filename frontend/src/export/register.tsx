/** The export docks onto the frame (`extensions.ts`): its notices on every page of the signed-in app. The dialog opens
 * from the note's menu and the folder's menu. */
import { SHELL_PARTS } from '../extensions'
import { ExportNotices } from './ExportNotices'

SHELL_PARTS.push({ key: 'export-notices', render: () => <ExportNotices /> })
