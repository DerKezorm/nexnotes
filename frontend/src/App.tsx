import type { ReactNode } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'

import { AppShell } from './components/AppShell'
import { NotFoundPage } from './components/NotFound'
import { AboutPage } from './pages/AboutPage'
import { InvitePage, LoginPage, ResetPage, SetupPage } from './pages/AuthPages'
import { NotesHome } from './pages/NotesHome'
import { SettingsPage } from './pages/SettingsPage'
import { FEATURE_ROUTES } from './extensions'
import { useAuth } from './state/auth'

/**
 * Everything behind the sign-in: without an account the page goes to the sign-in, and comes back after. An account
 * that still has to set up its second factor (the operator requires one) reaches its own account page only.
 *
 * The note features add their pages as routes inside the shell (`FEATURE_ROUTES` in `extensions.ts`), next to the
 * start area.
 */
function SignedIn({ children }: { children: ReactNode }) {
  const { status, me, ended } = useAuth()
  const location = useLocation()
  if (status === 'loading') return null
  if (status === 'setup') return <Navigate to="/setup" replace />
  if (status === 'signedOut') return <Navigate to={`/login?${ended ? 'ended=1&' : ''}next=${encodeURIComponent(location.pathname + location.search)}`} replace />
  if (me?.second_factor_setup_required && !location.pathname.startsWith('/settings')) return <Navigate to="/settings" replace />
  return <>{children}</>
}

export default function App() {
  return (
    <Routes>
      <Route path="setup" element={<SetupPage />} />
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
        {FEATURE_ROUTES.map((route) => (route.path === '' ? <Route key="index" index element={route.element} /> : null))}
        {FEATURE_ROUTES.filter((route) => route.path !== '').map((route) => (
          <Route key={route.path} path={route.path} element={route.element} />
        ))}
        <Route path="settings" element={<SettingsPage />} />
        <Route path="settings/:tab" element={<SettingsPage />} />
        <Route path="about" element={<AboutPage />} />
        {/* An address no page answers to says so, instead of silently showing the start. */}
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}
