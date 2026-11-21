/**
 * Search over all notes (NOTES-9). Importing this module docks it onto the frame (`register.tsx`).
 *
 * What other features use from here: `registerSmartFolderSave` (NOTES-7, "Als intelligenten Ordner sichern" with the
 * conditions of the search), `registerAttachmentOpener` (NOTES-10/11, a hit in a scan opens its view), `jumpToHit`
 * (from a hit to its place in the note) and `openSearch`.
 */
import './register'

export type { SearchConditions } from './conditions'
export { jumpToHit } from './jump'
export { openSearch } from './shortcuts'
export { registerAttachmentOpener, registerSmartFolderSave } from './registry'
