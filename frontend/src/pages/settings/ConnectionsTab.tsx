/**
 * Settings, "Connections" (drawing N2-Verbindungen, the frame only). What goes here comes with its own feature: devices
 * (NOTES-24), nextasks (NOTES-19), MCP keys (NOTES-20), the vault password (NOTES-16). They register themselves in
 * `CONNECTION_SECTIONS` (`extensions.ts`); until one does, the tab says what the place is for.
 */
import { Plug } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { CONNECTION_SECTIONS } from '../../extensions'

export function ConnectionsTab() {
  const { t } = useTranslation()
  if (CONNECTION_SECTIONS.length > 0) {
    return (
      <div className="space-y-6">
        {CONNECTION_SECTIONS.map((section) => (
          <div key={section.key}>{section.render()}</div>
        ))}
      </div>
    )
  }
  return (
    <div className="flex flex-col items-center gap-3 rounded-[12px] border border-dashed border-ink-600 px-6 py-10 text-center" data-testid="connections-empty">
      <Plug className="h-6 w-6 text-mist-500" aria-hidden />
      <p className="max-w-md text-sm text-mist-400">{t('connections.empty')}</p>
    </div>
  )
}
