/**
 * The operator's server settings: the hook every server card reads them through (`useServerSettings`), and the card of
 * the mail server (it moves to the module post 1.1.0 with the second part of the plan "Einstellungen"). The cards of
 * General and Text recognition are in `GeneralCards.tsx`, Storage and backups in `StorageArea.tsx`, sign-in in
 * `SignInCards.tsx`. Everything here is the server's; it applies to everyone.
 */
import { Mail } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ApiError, settingsApi, type AddressQuestion, type ServerSettings, type SettingsChange } from '../../api/client'
import { errorText } from '../../lib/errors'
import { dayTime } from '../../lib/format'
import { ASKED, useAction } from './actions'
import { Button, Card, Feedback, Input, Select } from './ui'

export type Server = ReturnType<typeof useServerSettings>

// eslint-disable-next-line react-refresh/only-export-components
export function useServerSettings() {
  const [settings, setSettings] = useState<ServerSettings | null>(null)
  const action = useAction()
  useEffect(() => {
    settingsApi.read().then(setSettings, () => undefined)
  }, [])
  /** The switch moves at once; the server's answer confirms it, a refusal puts it back. */
  const save = async (change: SettingsChange, done?: string) => {
    const before = settings
    if (settings) setSettings({ ...settings, ...change } as ServerSettings)
    const ok = await action.run(async () => setSettings(await settingsApi.save(change)), done)
    if (!ok) setSettings(before)
    return ok
  }
  /**
   * Saves the public address. authentik, set up by the button, knows the old one: the server then answers 409
   * `public_url_change` and saves nothing. That comes back as the question to put to the operator.
   */
  const saveAddress = async (public_url: string, confirm: boolean, done?: string): Promise<AddressQuestion | null> => {
    let question: AddressQuestion | null = null
    await action.run(async () => {
      try {
        setSettings(await settingsApi.save({ public_url, confirm_address: confirm }))
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== 'public_url_change') throw error
        question = { count: Number(error.values.count ?? 0), hand: Number(error.values.hand ?? 0), address: String(error.values.address ?? '') }
        return ASKED
      }
    }, done)
    return question
  }
  const reload = useCallback(() => settingsApi.read().then(setSettings, () => undefined), [])
  return { settings, save, saveAddress, reload, ...action }
}

export function MailCard({ server }: { server: Server }) {
  const { t, i18n } = useTranslation()
  const [draft, setDraft] = useState<SettingsChange>({})
  const [to, setTo] = useState('')
  const test = useAction()
  const s = server.settings
  if (!s) return null
  const value = { ...s, ...draft }
  return (
    <Card id="mail" icon={Mail} title={t('server.mail')} text={t('server.mailHint')}>
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault()
          void server.save(draft, t('settings.saved')).then(() => setDraft({}))
        }}
      >
        <Input label={t('server.smtpHost')} value={value.smtp_host ?? ''} onChange={(smtp_host) => setDraft({ ...draft, smtp_host })} placeholder="smtp.example.com" />
        <Input label={t('server.smtpPort')} type="number" value={String(value.smtp_port)} onChange={(port) => setDraft({ ...draft, smtp_port: Number(port) })} />
        <Select
          label={t('server.smtpSecurity')}
          value={value.smtp_security ?? 'starttls'}
          onChange={(smtp_security) => setDraft({ ...draft, smtp_security })}
          options={[
            { value: 'starttls', label: 'STARTTLS' },
            { value: 'tls', label: 'TLS' },
            { value: 'none', label: t('server.none') },
          ]}
        />
        <Input label={t('server.smtpUser')} value={value.smtp_user ?? ''} onChange={(smtp_user) => setDraft({ ...draft, smtp_user })} />
        <Input label={t('auth.password')} type="password" autoComplete="new-password" value={draft.smtp_password ?? ''} onChange={(smtp_password) => setDraft({ ...draft, smtp_password })} placeholder={s.smtp_password_set ? t('server.secretKept') : ''} />
        <Input label={t('server.smtpFrom')} value={value.smtp_from ?? ''} onChange={(smtp_from) => setDraft({ ...draft, smtp_from })} placeholder="notes@example.com" />
        <Input label={t('mail.senderName')} value={value.smtp_sender_name ?? ''} onChange={(smtp_sender_name) => setDraft({ ...draft, smtp_sender_name })} placeholder="nexnotes" />
        {value.smtp_security === 'none' && <p className="text-xs text-warn-500 sm:col-span-2">{t('mail.warningUnencrypted')}</p>}
        <div className="sm:col-span-2">
          <Button type="submit" accent busy={server.busy}>
            {t('common.save')}
          </Button>
        </div>
      </form>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void test.run(() => settingsApi.mailTest(to, i18n.language), t('server.mailSent'))
        }}
      >
        <Input label={t('server.mailTest')} value={to} onChange={setTo} placeholder="you@example.com" className="min-w-60 flex-1" />
        <Button type="submit" busy={test.busy} disabled={!to.trim()}>
          {t('server.send')}
        </Button>
      </form>
      {(s.mail_last_ok_at || s.mail_last_error) && (
        <p className="text-xs text-mist-500" data-testid="mail-status">
          {s.mail_last_ok_at && t('mail.lastOk', { when: dayTime(s.mail_last_ok_at, i18n.language) })}
          {s.mail_last_ok_at && s.mail_last_error ? ' · ' : ''}
          {s.mail_last_error && s.mail_last_error_at && t('mail.lastError', { when: dayTime(s.mail_last_error_at, i18n.language), error: errorText(s.mail_last_error) })}
        </p>
      )}
      <Feedback problem={test.problem ?? server.problem} done={test.done ?? server.done} />
    </Card>
  )
}
