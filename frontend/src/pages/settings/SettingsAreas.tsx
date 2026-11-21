/**
 * What each area of the settings shows: the cards as they were in the tabs before, only sorted by subject. The cards
 * themselves stay in their files (`AccountTab`, `ConnectionsTab`, `ServerCards`, `SignInCards`, `AccountsTab`,
 * `LogCard`); an area only picks them.
 */
import { AccountsTab } from './AccountsTab'
import { AccountTab } from './AccountTab'
import type { AreaSlug } from './areas'
import { ConnectionsTab } from './ConnectionsTab'
import { LogCard } from './LogCard'
import { BackupsCard, FeaturesCard, LanguagesCard, LimitsCard, MailCard, OcrCard, ProxyHint, useServerSettings } from './ServerCards'
import { SignInPart } from './SignInCards'

type ServerArea = 'general' | 'sign-in' | 'mail' | 'storage' | 'ocr'

export function AreaContent({ area }: { area: AreaSlug }) {
  switch (area) {
    case 'profile':
    case 'security':
    case 'appearance':
      return <AccountTab part={area} />
    case 'connections':
      return <ConnectionsTab />
    case 'accounts':
      return <AccountsTab />
    case 'log':
      return <LogCard />
    default:
      return <ServerCardsOf area={area} />
  }
}

/**
 * The server's own settings, for the operator. The hint about an unnamed proxy concerns the sign-in brake and the
 * addresses: it stands in General and in Sign-in.
 */
function ServerCardsOf({ area }: { area: ServerArea }) {
  const server = useServerSettings()
  if (!server.settings) return null
  return (
    <div className="space-y-6" data-testid={`server-${area}`}>
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
      {area === 'storage' && <BackupsCard server={server} />}
      {area === 'ocr' && <OcrCard server={server} />}
    </div>
  )
}
