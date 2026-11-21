/**
 * The installable web app (NOTES-23) docks onto the frame (`extensions.ts`): the service worker is signed up at the
 * start of a built page, a new version waiting shows as a bar over the page, the start goes to the folders on a phone
 * and to the last place in the installed app, and signing out or another account makes the worker forget.
 */
import { RefreshCw } from 'lucide-react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router-dom'

import { SHELL_BANNERS, SHELL_PARTS } from '../extensions'
import { onAccountChange } from '../state/account'
import { useMe } from '../state/auth'
import { lastPlace, onPhone, rememberPlace, startLooked, startPlace } from './place'
import { startWorker, takeUpdate, tell, usePwa } from './worker'

export function UpdateBanner() {
  const { t } = useTranslation()
  const { update } = usePwa()
  if (!update) return null
  return (
    <p role="status" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-accent-500/30 bg-[var(--color-accent-wash)] px-4 py-2 text-sm text-mist-100" data-testid="pwa-update">
      <RefreshCw className="h-4 w-4 shrink-0 text-accent-400" aria-hidden />
      <span>{t('pwa.update')}</span>
      <button type="button" className="min-h-11 font-semibold text-accent-400 hover:underline" onClick={takeUpdate}>
        {t('pwa.reload')}
      </button>
    </p>
  )
}

/** At the start: the folders on a phone (AC-1), the last place in the installed app (EC-6). While it runs, the
 * installed app keeps the place it shows. */
export function StartPlace() {
  const location = useLocation()
  const navigate = useNavigate()
  const me = useMe()
  const { standalone } = usePwa()
  const account = me?.id ?? null
  const here = location.pathname + location.search

  useEffect(() => {
    // Once per page load, at the first address of the signed-in app, as soon as the account is known.
    if (account === null || startLooked()) return
    const to = startPlace(location.pathname, location.search, onPhone(), lastPlace(account))
    if (to && to !== here) navigate(to, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account])

  useEffect(() => {
    if (standalone) rememberPlace(account, here)
  }, [standalone, account, here])
  return null
}

SHELL_BANNERS.push({ key: 'pwa-update', render: () => <UpdateBanner /> })
SHELL_PARTS.push({ key: 'pwa-start', render: () => <StartPlace /> })

// Signing out and another account: what was shared and anything outside the shell goes from the worker too.
onAccountChange(() => void tell({ type: 'nexnotes-forget' }))

if (import.meta.env.PROD) startWorker()
