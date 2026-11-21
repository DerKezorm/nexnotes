/**
 * The frame of the signed-in app: the sidebar on the left (on a phone behind a button), the page on the right. A
 * session that ends while the page is open shows its dialog over everything, so nothing written is lost.
 */
import { Menu } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Outlet, useLocation } from 'react-router-dom'

import { authApi } from '../api/client'
import { Logo } from './Logo'
import { SessionDialog } from './SessionDialog'
import { Sidebar } from './Sidebar'

/** Once per page load: the browser tells the server its time, so the log can warn of a clock far off (NOTES-1 EC-11). */
let clockTold = false

export function AppShell() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const location = useLocation()

  useEffect(() => {
    if (clockTold) return
    clockTold = true
    void authApi.clock().catch(() => undefined)
  }, [])

  // A new page closes the sidebar on a phone.
  useEffect(() => setOpen(false), [location.pathname])

  return (
    <div className="flex h-dvh overflow-hidden">
      <div className="hidden md:flex">
        <Sidebar />
      </div>
      {open && (
        <div className="fixed inset-0 z-40 flex md:hidden" role="presentation">
          <div className="shadow-2xl">
            <Sidebar onNavigate={() => setOpen(false)} />
          </div>
          <button type="button" aria-label={t('common.close')} className="flex-1 bg-scrim" onClick={() => setOpen(false)} />
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-ink-700 bg-ink-900 px-3 py-2 md:hidden">
          <button type="button" onClick={() => setOpen(true)} aria-label={t('app.openMenu')} className="nn-btn nn-btn-ghost w-10 px-0">
            <Menu className="h-4 w-4" strokeWidth={1.8} />
          </button>
          <Logo size={26} withWordmark />
        </header>
        <main className="nn-scroll min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
      <SessionDialog />
    </div>
  )
}
