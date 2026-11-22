/**
 * The app connects by address (NOTES-24 AC-2): it opens `/app-connect?state=<random>` in the system's sign-in sheet.
 * Without a session the page goes to the sign-in first (password, provider with passkey, second factor) and comes
 * back here; with one it asks at once "nexnotes-App verbinden?". "Verbinden" hands a one-time code to the app
 * (`nexnotes://connected?code=…&state=…`), "Abbrechen" says so to it (`…?error=cancelled&state=…`). Nothing happens
 * without the click.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, useLocation, useSearchParams } from 'react-router-dom'

import { cancelLink, devicesApi, validState } from '../devices/api'
import { problemText } from '../lib/errors'
import { go } from '../lib/providers'
import { useAuth } from '../state/auth'
import { AuthFrame } from './AuthPages'

export function AppConnectPage() {
  const { t } = useTranslation()
  const { status, me } = useAuth()
  const location = useLocation()
  const [params] = useSearchParams()
  const state = params.get('state')
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  if (status === 'loading') return null
  if (status === 'setup') return <Navigate to="/setup" replace />
  if (status === 'signedOut') return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />
  if (!validState(state)) {
    return (
      <AuthFrame title={t('appConnect.title')}>
        <p role="alert" className="text-sm text-bad-500" data-testid="app-connect-invalid">
          {t('appConnect.invalid')}
        </p>
      </AuthFrame>
    )
  }

  const connect = async () => {
    setBusy(true)
    setProblem('')
    try {
      const { link } = await devicesApi.connect(state)
      setDone(true)
      go(link)
    } catch (error) {
      setProblem(problemText(error))
      setBusy(false)
    }
  }

  if (done) {
    return (
      <AuthFrame title={t('appConnect.doneTitle')}>
        <p className="text-sm text-mist-300" role="status" data-testid="app-connect-done">
          {t('appConnect.done')}
        </p>
      </AuthFrame>
    )
  }
  return (
    <AuthFrame title={t('appConnect.title')} text={t('appConnect.text', { account: me?.display_name || me?.name || '' })}>
      {problem && (
        <p role="alert" className="mb-3 text-sm text-bad-500" data-testid="app-connect-problem">
          {problem}
        </p>
      )}
      <div className="flex flex-col gap-2">
        <button type="button" disabled={busy} onClick={() => void connect()} className="nn-btn nn-btn-accent w-full justify-center" data-testid="app-connect-confirm">
          {t('appConnect.confirm')}
        </button>
        <button type="button" disabled={busy} onClick={() => go(cancelLink(state))} className="nn-btn nn-btn-ghost w-full justify-center" data-testid="app-connect-cancel">
          {t('common.cancel')}
        </button>
      </div>
    </AuthFrame>
  )
}
