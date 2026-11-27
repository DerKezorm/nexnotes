/**
 * The operator's server settings: the hook every server card reads them through (`useServerSettings`), and the card of
 * the mail server, the module post's since 1.1.0. The cards of General and Text recognition are in `GeneralCards.tsx`,
 * Storage and backups in `StorageArea.tsx`, sign-in in `SignInArea.tsx`. Everything here is the server's; it applies to everyone.
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { api, ApiError, settingsApi, type AddressQuestion, type ServerSettings, type SettingsChange } from '../../api/client'
import { problemText } from '../../lib/errors'
import { formatMoment } from '../../vendor/nexui'
import { ASKED, useAction } from './actions'
import { MailCard as PostMailCard } from '../../vendor/nexpost/MailCard'
import type { PostRequest } from '../../vendor/nexpost/mailserver'

export type Server = ReturnType<typeof useServerSettings>

// eslint-disable-next-line react-refresh/only-export-components
export function useServerSettings() {
  const [settings, setSettings] = useState<ServerSettings | null>(null)
  /** Why the settings could not be read (shown with "Erneut versuchen"); empty while they load or once they came. */
  const [failed, setFailed] = useState('')
  const action = useAction()
  const reload = useCallback(
    () =>
      settingsApi.read().then(
        (read) => {
          setFailed('')
          setSettings(read)
        },
        (error: unknown) => setFailed(problemText(error)),
      ),
    [],
  )
  useEffect(() => {
    void reload()
  }, [reload])
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
  return { settings, failed, save, saveAddress, reload, ...action }
}

/** The client of the post module's card: nexnotes' requests (its tab header, its errors with their codes). */
const postRequest: PostRequest = <T,>(path: string, init: { method?: string; body?: unknown } = {}) =>
  api<T>(path, { method: (init.method ?? 'GET') as 'GET' | 'PUT' | 'POST', body: init.body })

/** Server › Mail (post 1.1.0): the module's card "Mail" with nexnotes' sentence of what it sends. */
export function MailCard() {
  const { t, i18n } = useTranslation()
  return (
    <PostMailCard
      request={postRequest}
      subtitle={t('server.mailHint')}
      senderPlaceholder="notes@example.com"
      language={i18n.language}
      when={formatMoment}
    />
  )
}
