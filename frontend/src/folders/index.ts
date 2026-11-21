/**
 * Folders and the inbox (NOTES-4). Importing this module docks them onto the frame (`register.tsx`).
 *
 * What other features use from here: `useCurrentFolder` (where a new note lands, AC-9), `registerNoteActions` (how a
 * note is started and opened), `startNoteDrag` (rows of notes onto folders), `refreshFolders` (after a note was made or
 * deleted, so that the counts follow) and `NOTES_MOVED_EVENT`.
 */
import './register'

export { NOTES_MOVED_EVENT, registerNoteActions, startNoteDrag } from './actions'
export { refreshFolders, setCurrentFolder, useCurrentFolder, useFolders } from './store'
