/**
 * The app connects by address (NOTES-24 AC-2): it opens `/app-connect?state=<random>` (with a PKCE `challenge` since
 * the module geraete) in the system's sign-in sheet. Without a session the page goes to the sign-in first (password,
 * provider with passkey, second factor) and comes back here; with one it asks at once. The page itself is the
 * module's: "Verbinden" hands a one-time code to the app (`nexnotes://connected?code=…&state=…`), "Abbrechen" says so
 * to it (`…?error=cancelled&state=…`). Nothing happens without the click.
 */
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, useLocation } from 'react-router-dom'

import { Logo } from '../components/Logo'
import { ThemeSwitcher } from '../components/ThemeSwitcher'
import { deviceRequest } from '../devices/request'
import { useAuth } from '../state/auth'
import { AppConnectPage as SharedAppConnectPage } from '../vendor/nexgeraete'

/** The frame of the pages before signing in, around the module's card. */
function frame(card: ReactNode): ReactNode {
  return (
    <div className="nn-scroll flex min-h-dvh flex-col overflow-y-auto">
      <header className="flex items-center justify-between px-5 py-4">
        <Logo withWordmark />
        <ThemeSwitcher />
      </header>
      <main className="flex flex-1 items-start justify-center px-4 pt-[6vh] pb-10">{card}</main>
    </div>
  )
}

export function AppConnectPage() {
  const { i18n } = useTranslation()
  const { status, me } = useAuth()
  const location = useLocation()

  if (status === 'loading') return null
  if (status === 'setup') return <Navigate to="/setup" replace />
  if (status === 'signedOut' || !me) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />
  return (
    <SharedAppConnectPage
      request={deviceRequest}
      app="nexnotes"
      scheme="nexnotes"
      account={{ name: me.display_name || me.name, login: me.name }}
      language={i18n.language}
      search={location.search}
      frame={frame}
    />
  )
}
