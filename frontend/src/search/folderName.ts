import { useTranslation } from 'react-i18next'

import { useFolders } from '../folders/store'

/** The folder's name for sentences ("in „Arbeit“"). */
export function useFolderName(folderId: string): string {
  const { t } = useTranslation()
  const tree = useFolders()
  if (!folderId) return ''
  if (tree.inbox?.id === folderId) return t('notes.inbox')
  return tree.byId.get(folderId)?.name ?? ''
}
