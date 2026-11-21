/**
 * Smart folders dock onto the frame (`extensions.ts`, NOTES-7): the section "Intelligent" in the sidebar right after
 * the folders (drawing "Seitenleiste"), the list `/smart/<id>` in the notes' workspace, the pages to make and change
 * one, and the buttons "Als intelligenten Ordner sichern" of the search (NOTES-9 AC-6) and of a tag's page (NOTES-5
 * AC-6), which appear once this is here.
 */
import { FEATURE_ROUTES, SIDEBAR_SECTIONS } from '../extensions'
import { goTo } from '../notes/context'
import { registerListName } from '../notes/workspace'
import { registerSmartFolderSave, type SearchConditions } from '../search'
import { registerSmartFolderSaver, type TagCondition } from '../tags'
import i18n from '../i18n'
import { smartApi } from './api'
import { fromSearch, nameFromSearch, smartName } from './conditions'
import { SmartEditor, type NewSmartFolder } from './SmartEditor'
import { SmartFolderPage } from './SmartFolderPage'
import { SmartSection } from './SmartSection'
import { currentSmartFolders, refreshSmartFolders } from './store'

const folders = SIDEBAR_SECTIONS.findIndex((section) => section.key === 'folders')
SIDEBAR_SECTIONS.splice(folders >= 0 ? folders + 1 : SIDEBAR_SECTIONS.length, 0, { key: 'smart', render: () => <SmartSection /> })
FEATURE_ROUTES.push(
  { path: 'smart/new', element: <SmartEditor /> },
  { path: 'smart/:id/edit', element: <SmartEditor /> },
  { path: 'smart/:id', element: <SmartFolderPage />, list: true },
)

/** The search's conditions open "Neuer intelligenter Ordner" with exactly them; the member names it and saves (AC-5). */
export function saveSearch(conditions: SearchConditions): void {
  const handed: NewSmartFolder = { conditions: fromSearch(conditions), name: nameFromSearch(conditions) }
  goTo('/smart/new', handed)
}

/** A tag's page makes the smart folder "#tag" at once and opens it (NOTES-5 AC-6); a name taken is said there. */
export async function saveTag(condition: TagCondition, name: string): Promise<string> {
  const made = await smartApi.create({ name, match: 'all', conditions: [condition] })
  await refreshSmartFolders()
  return `/smart/${encodeURIComponent(made.id)}`
}

registerSmartFolderSave(saveSearch)
registerSmartFolderSaver(saveTag)
registerListName((path) => {
  const match = /^\/smart\/([^/]+)$/.exec(path)
  if (!match) return null
  const folder = currentSmartFolders().find((item) => item.id === decodeURIComponent(match[1]))
  return folder ? smartName(folder, i18n.t) : i18n.t('smart.heading')
})
