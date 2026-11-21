/**
 * Smart folders (NOTES-7). Importing this module docks them onto the frame (`register.tsx`).
 *
 * What other features use from here: `smartApi` (the server's routes) and `useSmartFolders` (the list).
 */
import './register'

export { smartApi, type Condition, type SmartFolder } from './api'
export { refreshSmartFolders, useSmartFolders } from './store'
