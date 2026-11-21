/**
 * What other features hang onto tags.
 *
 * Smart folders (NOTES-7) register `saveAsSmartFolder`: the page of a tag then shows "Als intelligenten Ordner sichern"
 * (NOTES-5 AC-6, NOTES-7 AC-5) and hands it the condition "tag has …". Without it the button is not there.
 */

/** The condition of a smart folder that a tag's page saves: "Schlagwort hat …". */
export type TagCondition = { kind: 'tag'; op: 'has'; key: string; label: string }

/** Makes the smart folder and gives the address it opens at. */
export type SaveAsSmartFolder = (condition: TagCondition, name: string) => Promise<string>

let saver: SaveAsSmartFolder | null = null

export function registerSmartFolderSaver(save: SaveAsSmartFolder | null): void {
  saver = save
}

export function smartFolderSaver(): SaveAsSmartFolder | null {
  return saver
}

export function tagCondition(key: string, label: string): TagCondition {
  return { kind: 'tag', op: 'has', key, label }
}
