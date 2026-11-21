import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'

import { useFolders } from '../folders/store'

/** The name of a folder of the account by its id, for the sentences of conditions; `null` for one not there. */
export function useFolderName(): (id: string) => string | null {
  const { t } = useTranslation()
  const tree = useFolders()
  return useCallback((id: string) => (tree.inbox?.id === id ? t('notes.inbox') : (tree.byId.get(id)?.name ?? null)), [tree, t])
}
