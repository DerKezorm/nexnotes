/**
 * The history of notes (NOTES-15). Importing this module docks its page onto the frame (`register.tsx`). The editor
 * uses `historyHref` for its menu entry and `RestoreWatch` for the notice when somebody else restores a version.
 */
import './register'

export { historyHref } from './href'
export { RestoreWatch } from './RestoreWatch'
