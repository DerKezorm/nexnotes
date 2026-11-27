/**
 * What each area of the settings shows, in the order of the plan "Einstellungen": only cards. The cards stay in their
 * files (`AccountTab`, `AppearanceArea`, `ConnectionsTab`, `GeneralCards`, `SignInArea`, `ServerCards`, `StorageArea`,
 * `AccountsTab`, `LogCard`, `AboutArea`); an area only picks them.
 */
import { useTranslation } from 'react-i18next'

import { AppsOperator } from '../../connect/AppsArea'
import { AllKeys, Interfaces } from '../../tokens/KeysCards'
import { Button, Notice, type GeneralPart } from '../../vendor/nexui'
import { AboutArea } from './AboutArea'
import { AccountsTab } from './AccountsTab'
import { AccountTab } from './AccountTab'
import { AppearanceArea } from './AppearanceArea'
import type { AreaSlug } from './areas'
import { ConnectionsTab } from './ConnectionsTab'
import { FeaturesCard, LanguagesCard, LimitsCard, OcrCard } from './GeneralCards'
import { LogCard } from './LogCard'
import { MailCard, useServerSettings } from './ServerCards'
import { NotificationsArea } from './NotificationsArea'
import { SignInArea } from './SignInArea'
import { StorageArea } from './StorageArea'

/** The cards of Server › General, in the order they stand (ui 1.1.3, U-3): the area's line names exactly these. No
 * card "Web Push" in nexnotes (E48); "Andere nex-Apps" and "Schnittstellen" stand under Server › Connections (E67). */
// eslint-disable-next-line react-refresh/only-export-components
export const GENERAL_PARTS: readonly GeneralPart[] = ['limits', 'features', 'languages']

export function AreaContent({ area }: { area: AreaSlug }) {
  switch (area) {
    case 'profile':
    case 'security':
      return <AccountTab part={area} />
    case 'appearance':
      return <AppearanceArea />
    case 'notifications':
      return <NotificationsArea />
    case 'connections':
      return <ConnectionsTab />
    case 'storage':
      return <StorageArea />
    case 'accounts':
      return (
        <>
          <AccountsTab />
          <AllKeys />
        </>
      )
    case 'sign-in':
      return <SignInArea />
    case 'mail':
      return <MailCard />
    case 'log':
      return <LogCard />
    case 'about':
      return <AboutArea />
    case 'server-connections':
      // E67: the operator's mirror of My account › Connections: the other nex apps, then the interfaces.
      return (
        <>
          <AppsOperator />
          <Interfaces />
        </>
      )
    default:
      return <ServerCardsOf area={area} />
  }
}

/** The server's own settings, for the operator, read once for the cards of an area. */
function ServerCardsOf({ area }: { area: 'general' | 'ocr' }) {
  const { t } = useTranslation()
  const server = useServerSettings()
  if (!server.settings) {
    if (!server.failed) return null
    // Not read (the network, the server): said, with the way to ask again, instead of an empty area.
    return (
      <Notice tone="danger" testId="server-settings-failed">
        <span className="flex flex-wrap items-center justify-between gap-3">
          <span>{server.failed}</span>
          <Button kind="secondary" icon="RotateCcw" onClick={() => void server.reload()} testId="server-settings-retry">
            {t('common.retry')}
          </Button>
        </span>
      </Notice>
    )
  }
  return (
    <>
      {area === 'general' && (
        <>
          <LimitsCard server={server} />
          <FeaturesCard server={server} />
          <LanguagesCard />
        </>
      )}
      {area === 'ocr' && <OcrCard server={server} />}
    </>
  )
}
