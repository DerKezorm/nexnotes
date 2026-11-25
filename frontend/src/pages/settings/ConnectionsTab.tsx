/**
 * Settings, "Connections" (plan "Einstellungen", Verbindungen), the frame only: each card comes with its own feature and
 * registers itself in `CONNECTION_SECTIONS` (`extensions.ts`), in the plan's order: devices (NOTES-24), installing on
 * this device (NOTES-23), nextasks (NOTES-19), the API keys and MCP (NOTES-20, NOTES-25). Until one does, the area
 * says what the place is for.
 */
import { Plug } from 'lucide-react'
import { Fragment } from 'react'
import { useTranslation } from 'react-i18next'

import { CONNECTION_SECTIONS } from '../../extensions'

export function ConnectionsTab() {
  const { t } = useTranslation()
  if (CONNECTION_SECTIONS.length > 0) {
    return (
      <>
        {CONNECTION_SECTIONS.map((section) => (
          <Fragment key={section.key}>{section.render()}</Fragment>
        ))}
      </>
    )
  }
  return (
    <div className="flex flex-col items-center gap-3 rounded-[12px] border border-dashed border-ink-600 px-6 py-10 text-center" data-testid="connections-empty">
      <Plug className="h-6 w-6 text-mist-500" aria-hidden />
      <p className="max-w-md text-sm text-mist-400">{t('connections.empty')}</p>
    </div>
  )
}
