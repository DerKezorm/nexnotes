import { Fragment, type ReactNode } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'

import { AppShell } from './components/AppShell'
import { NotFoundPage } from './components/NotFound'
import { InvitePage, LoginPage, ResetPage, SetupPage } from './pages/AuthPages'
import { NotesHome } from './pages/NotesHome'
import { FormerAboutAddress, SettingsPage } from './pages/SettingsPage'
import { FEATURE_ROUTES, LIST_LAYOUT, type FeatureRoute } from './extensions'
import { OfflinePage } from './pwa/OfflinePage'
import { SharePage } from './pwa/share/SharePage'
import { useAuth } from './state/auth'

/**
 * Everything behind the sign-in: without an account the page goes to the sign-in, and comes back after. An account
 * that still has to set up its second factor (the operator requires one) reaches the settings only, at Security.
 *
 * The note features add their pages as routes inside the shell (`FEATURE_ROUTES` in `extensions.ts`), next to the
 * start area. Another account in the same tab gets the shell drawn anew; the stores outside the tree forget the
 * account before through `state/account.ts`.
 */
function SignedIn({ children }: { children: ReactNode }) {
  const { status, me, ended } = useAuth()
  const location = useLocation()
  if (status === 'loading') return null
  if (status === 'setup') return <Navigate to="/setup" replace />
  if (status === 'signedOut') return <Navigate to={`/login?${ended ? 'ended=1&' : ''}next=${encodeURIComponent(location.pathname + location.search)}`} replace />
  if (me?.second_factor_setup_required && !location.pathname.startsWith('/settings')) return <Navigate to="/settings/security" replace />
  // Drawn anew for every account: no list, hit or open dialog of the account before stays in the tab.
  return <Fragment key={me?.id ?? 'nobody'}>{children}</Fragment>
}

function featureRoute(route: FeatureRoute) {
  return route.path === '' ? <Route key="index" index element={route.element} /> : <Route key={route.path} path={route.path} element={route.element} />
}

export default function App() {
  const { status } = useAuth()
  const location = useLocation()
  const inLayout = (route: FeatureRoute) => Boolean(route.list && LIST_LAYOUT.element)
  // Without the server no page but "No connection" (NOTES-23 AC-4); the page of something shared keeps its form, so
  // nothing shared is lost (EC-3).
  if (status === 'offline' && location.pathname !== '/share') return <OfflinePage />
  return (
    <Routes>
      <Route path="setup" element={<SetupPage />} />
      {/* "Save to nexnotes": what another app shared (NOTES-23 AC-5); signs in by itself, outside the shell. */}
      <Route path="share" element={<SharePage />} />
      <Route path="login" element={<LoginPage />} />
      <Route path="invite/:token" element={<InvitePage />} />
      <Route path="reset/:token" element={<ResetPage />} />
      <Route
        element={
          <SignedIn>
            <AppShell />
          </SignedIn>
        }
      >
        {!FEATURE_ROUTES.some((route) => route.path === '') && <Route index element={<NotesHome />} />}
        {/* The lists share one workspace, so the notes beside them stay while the list changes (NOTES-8 AC-9). */}
        {FEATURE_ROUTES.some(inLayout) && <Route element={LIST_LAYOUT.element}>{FEATURE_ROUTES.filter(inLayout).map(featureRoute)}</Route>}
        {FEATURE_ROUTES.filter((route) => !inLayout(route)).map(featureRoute)}
        <Route path="settings" element={<SettingsPage />} />
        <Route path="settings/:tab" element={<SettingsPage />} />
        {/* "About nexnotes" is an area of the settings; the address of before leads there. */}
        <Route path="about" element={<FormerAboutAddress />} />
        {/* An address no page answers to says so, instead of silently showing the start. */}
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}
