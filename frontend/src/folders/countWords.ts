/** The numbers of a folder in words, for screen readers: "Arbeit, 3 notes, 12 including subfolders". */
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'

import type { Folder } from './api'
import { hasSubfolders, notesBelow, useFolders } from './store'

export function useFolderCountWords(): (folder: Folder) => string {
  const { t } = useTranslation()
  const tree = useFolders()
  return useCallback(
    (folder: Folder) => {
      const own = t('folders.count.notes', { count: folder.count })
      if (!hasSubfolders(tree, folder.id)) return own
      return `${own}, ${t('folders.count.inTree', { count: folder.count + notesBelow(tree, folder.id) })}`
    },
    [t, tree],
  )
}
