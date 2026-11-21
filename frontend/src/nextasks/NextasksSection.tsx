/**
 * Settings, Connections: "nextasks" (NOTES-19, drawing N2-Verbindungen). Not connected, it says how (AC-4); address and
 * key are checked at once and the card says "Verbunden mit … als …" (AC-5); the key can be changed, or nextasks
 * disconnected. A nextasks with another API says so here (EC-7).
 */
import { ListChecks } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '../components/Dialog'
import { Field, Problem } from '../components/Field'
import { problemText } from '../lib/errors'
import { Card } from '../pages/settings/ui'
import { nextasksApi, setNextasks } from './api'
import { useNextasks } from './hooks'

export function NextasksSection() {
  const { t } = useTranslation()
  const status = useNextasks()
  const [editing, setEditing] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [problem, setProblem] = useState('')

  const disconnect = async () => {
    setProblem('')
    try {
      await nextasksApi.disconnect()
      setNextasks({ connected: false, local_allowed: Boolean(status?.local_allowed) })
    } catch (error) {
      setProblem(problemText(error))
    }
    setLeaving(false)
  }

  return (
    <Card id="nextasks" icon={ListChecks} title={t('nextasks.section.title')} text={t('nextasks.section.text')}>
      <Problem text={problem} />
      {status?.connected && !editing && (
        <>
          <p className="flex items-center gap-2 text-sm text-mist-100" data-testid="nextasks-connected">
            <span className="h-2 w-2 shrink-0 rounded-full bg-ok-500" aria-hidden />
            {t('nextasks.section.connected', { host: status.host, name: status.name || '?' })}
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="nn-btn nn-btn-ghost" onClick={() => setEditing(true)} data-testid="nextasks-change">
              {t('nextasks.section.changeKey')}
            </button>
            <button type="button" className="nn-btn nn-btn-ghost" onClick={() => setLeaving(true)} data-testid="nextasks-disconnect">
              {t('nextasks.section.disconnect')}
            </button>
          </div>
        </>
      )}
      {status && (!status.connected || editing) && (
        <ConnectForm
          url={status.url ?? ''}
          localAllowed={status.local_allowed}
          changing={status.connected}
          onCancel={status.connected ? () => setEditing(false) : undefined}
          onDone={() => setEditing(false)}
        />
      )}
      {leaving && (
        <Dialog title={t('nextasks.section.disconnectTitle')} onClose={() => setLeaving(false)}>
          <p className="text-sm text-mist-300">{t('nextasks.section.disconnectText')}</p>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className="nn-btn nn-btn-ghost" onClick={() => setLeaving(false)}>
              {t('common.cancel')}
            </button>
            <button type="button" className="nn-btn nn-btn-danger" onClick={() => void disconnect()} data-testid="nextasks-disconnect-confirm">
              {t('nextasks.section.disconnect')}
            </button>
          </div>
        </Dialog>
      )}
    </Card>
  )
}

function ConnectForm({ url: before, localAllowed, changing, onCancel, onDone }: { url: string; localAllowed: boolean; changing: boolean; onCancel?: () => void; onDone: () => void }) {
  const { t } = useTranslation()
  const [url, setUrl] = useState(before)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')

  const connect = async () => {
    if (busy || !url.trim() || !token.trim()) return
    setBusy(true)
    setProblem('')
    try {
      setNextasks(await nextasksApi.connect(url.trim(), token.trim()))
      setToken('')
      onDone()
    } catch (error) {
      setProblem(problemText(error))
    }
    setBusy(false)
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        void connect()
      }}
      data-testid="nextasks-form"
    >
      {!changing && <p className="text-sm text-mist-300" data-testid="nextasks-how">{t('nextasks.section.how')}</p>}
      <Field label={t('nextasks.section.url')} value={url} onChange={setUrl} type="url" maxLength={500} hint={t('nextasks.section.urlHint')} />
      <Field label={t('nextasks.section.key')} value={token} onChange={setToken} type="password" autoComplete="off" maxLength={500} hint={t('nextasks.section.keyHint')} />
      {!localAllowed && <p className="text-xs text-mist-500" data-testid="nextasks-local">{t('nextasks.section.localOff')}</p>}
      <Problem text={problem} />
      <div className="flex justify-end gap-2">
        {onCancel && (
          <button type="button" className="nn-btn nn-btn-ghost" onClick={onCancel}>
            {t('common.cancel')}
          </button>
        )}
        <button type="submit" className="nn-btn nn-btn-accent" disabled={busy || !url.trim() || !token.trim()} data-testid="nextasks-connect">
          {busy ? t('nextasks.section.checking') : t('nextasks.section.connect')}
        </button>
      </div>
    </form>
  )
}
