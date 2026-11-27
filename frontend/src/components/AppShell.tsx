/**
 * The frame of the signed-in app: the sidebar on the left (on a phone behind a button), the page on the right. A
 * session that ends while the page is open shows its dialog over everything, so nothing written is lost. After the
 * password was set through the operator's reset link, the account hears so once it is signed in (NOTES-2 AC-7).
 */
import { Menu } from 'lucide-react'
import { Fragment, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Outlet, useLocation } from 'react-router-dom'

import { authApi } from '../api/client'
import { SHELL_BANNERS, SHELL_PARTS } from '../extensions'
import { useColumnWidth } from '../lib/columns'
import { useAuth } from '../state/auth'
import { ColumnHandle } from './ColumnHandle'
import { Dialog } from './Dialog'
import { Logo } from './Logo'
import { SessionDialog } from './SessionDialog'
import { Sidebar } from './Sidebar'
import { useSidebarFolded } from './sidebarFold'

/** Once per page load: the browser tells the server its time, so the log can warn of a clock far off (NOTES-1 EC-11). */
let clockTold = false

export function AppShell() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const location = useLocation()
  const [sidebarWidth] = useColumnWidth('sidebar')
  const folded = useSidebarFolded()

  useEffect(() => {
    if (clockTold) return
    clockTold = true
    void authApi.clock().catch(() => undefined)
  }, [])

  // A new page closes the sidebar on a phone.
  useEffect(() => setOpen(false), [location.pathname])

  // `relative` (B7): hidden texts (`sr-only`, absolute) are placed and clipped in this frame instead of making the page
  // taller than the window.
  return (
    <div className="relative flex h-dvh overflow-hidden">
      {/* Folded away beside the notes ("Hide sidebar", `sidebarFold.ts`): hidden, not gone, so it keeps its state. */}
      <div className={'relative hidden shrink-0 ' + (folded ? '' : 'md:flex')} data-testid="shell-sidebar">
        <Sidebar width={sidebarWidth} />
        <ColumnHandle column="sidebar" />
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
        {SHELL_BANNERS.map((banner) => (
          <div key={banner.key}>{banner.render()}</div>
        ))}
        <main className="nn-scroll min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
      <SessionDialog />
      <ResetNotice />
      {SHELL_PARTS.map((part) => (
        <Fragment key={part.key}>{part.render()}</Fragment>
      ))}
    </div>
  )
}

/** "Your password was reset through a link from the operator", until put away: whoever used the link, the account
 * learns of it, so an operator who set a password and signed in as somebody else does not stay unnoticed. */
function ResetNotice() {
  const { t } = useTranslation()
  const { me, setMe } = useAuth()
  const [busy, setBusy] = useState(false)
  if (!me?.password_reset_notice) return null
  const seen = async () => {
    setBusy(true)
    try {
      setMe(await authApi.resetNoticeSeen())
    } catch {
      // Shown again at the next load; nothing is lost.
      setMe({ ...me, password_reset_notice: false })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog title={t('resetNotice.title')} onClose={() => void seen()}>
      <div className="space-y-3" data-testid="reset-notice">
        <p className="text-sm text-mist-200">{t('resetNotice.text')}</p>
        <p className="text-sm text-mist-400">{t('resetNotice.hint')}</p>
        <div className="flex justify-end">
          <button type="button" disabled={busy} className="nn-btn nn-btn-accent" onClick={() => void seen()}>
            {t('resetNotice.button')}
          </button>
        </div>
      </div>
    </Dialog>
  )
}
