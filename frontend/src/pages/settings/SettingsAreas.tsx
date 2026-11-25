/**
 * What each area of the settings shows, in the order of the plan "Einstellungen": only cards. The cards stay in their
 * files (`AccountTab`, `AppearanceArea`, `ConnectionsTab`, `GeneralCards`, `SignInCards`, `ServerCards`, `StorageArea`,
 * `AccountsTab`, `LogCard`, `AboutArea`); an area only picks them.
 */
import { AllTokensCard } from '../../tokens/AllTokensCard'
import { AboutArea } from './AboutArea'
import { AccountsTab } from './AccountsTab'
import { AccountTab } from './AccountTab'
import { AppearanceArea } from './AppearanceArea'
import type { AreaSlug } from './areas'
import { ConnectionsTab } from './ConnectionsTab'
import { FeaturesCard, LanguagesCard, LimitsCard, OcrCard, ProxyHint } from './GeneralCards'
import { LogCard } from './LogCard'
import { MailCard, useServerSettings } from './ServerCards'
import { SignInPart } from './SignInCards'
import { StorageArea } from './StorageArea'

export function AreaContent({ area }: { area: AreaSlug }) {
  switch (area) {
    case 'profile':
    case 'security':
      return <AccountTab part={area} />
    case 'appearance':
      return <AppearanceArea />
    case 'connections':
      return <ConnectionsTab />
    case 'storage':
      return <StorageArea />
    case 'accounts':
      return (
        <>
          <AccountsTab />
          <AllTokensCard />
        </>
      )
    case 'log':
      return <LogCard />
    case 'about':
      return <AboutArea />
    default:
      return <ServerCardsOf area={area} />
  }
}

/**
 * The server's own settings, for the operator. The hint about an unnamed proxy concerns the sign-in brake and the
 * addresses: it stands in General and in Sign-in until the card "Bereit fürs Internet?" (konten 1.1.0) takes it over.
 */
function ServerCardsOf({ area }: { area: 'general' | 'sign-in' | 'mail' | 'ocr' }) {
  const server = useServerSettings()
  if (!server.settings) return null
  return (
    <>
      {(area === 'general' || area === 'sign-in') && <ProxyHint server={server} />}
      {area === 'general' && (
        <>
          <LimitsCard server={server} />
          <FeaturesCard server={server} />
          <LanguagesCard />
        </>
      )}
      {area === 'sign-in' && <SignInPart server={server} />}
      {area === 'mail' && <MailCard server={server} />}
      {area === 'ocr' && <OcrCard server={server} />}
    </>
  )
}
