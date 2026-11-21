/**
 * Where later features dock onto the search, without the search knowing them:
 *
 * - `registerSmartFolderSave` (NOTES-7): "Als intelligenten Ordner sichern" makes a smart folder with exactly the
 *   conditions of the search (AC-6). Without it the button is not there.
 * - `registerAttachmentOpener` (NOTES-10/11): a hit in the text of a scan or PDF opens the view of that attachment at
 *   the place (AC-5). Without it the note opens.
 */
import type { Hit } from './api'
import type { SearchConditions } from './conditions'

export type SmartFolderSave = (conditions: SearchConditions) => void | Promise<void>
export type AttachmentOpener = (hit: Hit) => void

let smartFolderSave: SmartFolderSave | null = null
let attachmentOpener: AttachmentOpener | null = null

export function registerSmartFolderSave(save: SmartFolderSave | null): void {
  smartFolderSave = save
}

export function smartFolderSaver(): SmartFolderSave | null {
  return smartFolderSave
}

export function registerAttachmentOpener(open: AttachmentOpener | null): void {
  attachmentOpener = open
}

export function attachmentOpenerFor(): AttachmentOpener | null {
  return attachmentOpener
}
