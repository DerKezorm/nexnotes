/**
 * Tags (NOTES-5). Importing this module docks them onto the frame (`register.tsx`).
 *
 * What other features use from here: `registerSmartFolderSaver` (smart folders, NOTES-7: the button on a tag's page),
 * `tagHref` (the address of a tag's page), `findTags`/`keyOf` (the rule), `useTags`/`refreshTags` (the list).
 */
import './register'

export { registerSmartFolderSaver, tagCondition, type TagCondition } from './actions'
export { cleanName, findTags, keyOf, tagHref } from './rules'
export { refreshTags, useTags } from './store'
