/**
 * What each area of the settings shows, in the order of the plan "Einstellungen": only cards. The cards stay in their
 * files (`AccountTab`, `AppearanceArea`, `ConnectionsTab`, `GeneralCards`, `SignInArea`, `ServerCards`, `StorageArea`,
 * `AccountsTab`, `LogCard`, `AboutArea`); an area only picks them.
 */
import { AllKeys, Interfaces } from '../../tokens/KeysCards'
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
    default:
      return <ServerCardsOf area={area} />
  }
}

/** The server's own settings, for the operator, read once for the cards of an area. */
function ServerCardsOf({ area }: { area: 'general' | 'ocr' }) {
  const server = useServerSettings()
  if (!server.settings) return null
  return (
    <>
      {area === 'general' && (
        <>
          <LimitsCard server={server} />
          <FeaturesCard server={server} />
          <Interfaces />
          <LanguagesCard />
        </>
      )}
      {area === 'ocr' && <OcrCard server={server} />}
    </>
  )
}
