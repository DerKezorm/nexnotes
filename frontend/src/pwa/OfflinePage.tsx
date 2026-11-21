/**
 * "No connection" (NOTES-23 AC-4, drawing "Handy-Offline"): the installed app opened without network, or the server
 * is down. No sign-in page for that. "Try again" asks at once; the page asks by itself every few seconds and as soon as
 * the network is back (`state/auth.tsx`). Writing without network is the iPhone and iPad app's.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { LogoMark } from '../components/Logo'
import { useAuth } from '../state/auth'

export function OfflinePage() {
  const { t } = useTranslation()
  const { refresh } = useAuth()
  const [trying, setTrying] = useState(false)
  const retry = async () => {
    setTrying(true)
    try {
      await refresh()
    } finally {
      setTrying(false)
    }
  }
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 py-10 text-center" data-testid="offline">
      <LogoMark size={72} />
      <h1 className="text-[22px] font-bold">{t('pwa.offline.title')}</h1>
      <p className="max-w-sm text-[15px] leading-relaxed text-mist-400">{t('pwa.offline.text')}</p>
      <button type="button" className="nn-btn nn-btn-accent min-h-12 px-6 text-base" disabled={trying} onClick={() => void retry()} data-testid="offline-retry">
        {t('pwa.offline.retry')}
      </button>
      <p className="max-w-[300px] text-[13px] leading-normal text-mist-500">{t('pwa.offline.hint')}</p>
    </main>
  )
}
