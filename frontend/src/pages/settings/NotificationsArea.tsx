/**
 * Mein Konto › Benachrichtigungen (plan "Einstellungen", E57): nexnotes notifies through the bell of shared notes and
 * folders, so it has the area with the kit's first card "Auf welchem Weg" (`NotifyWays`): this browser (on or off, a
 * test notification), the account's browsers with notifications (removing another), and the iPhone and iPad app (it
 * is connected under Verbindungen). No mail: nexnotes sends no notification by mail. Which notes notify stays at the
 * bell of each note and folder.
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { api } from '../../api/client'
import { problemText } from '../../lib/errors'
import { dayTime } from '../../lib/format'
import { allowBrowser, browserState, stopBrowser, type BrowserState } from '../../notify/browser'
import { Notice, NotifyWays } from '../../vendor/nexui'
import { areaPath } from './areas'

type Devices = {
  apps: { id: number; name: string; on: boolean }[]
  browsers: { id: number; browser: string; system: string; this: boolean; since: string | null; last_ok_at: string | null }[]
  this_browser: boolean
}

export function NotificationsArea() {
  const { t, i18n } = useTranslation()
  const [devices, setDevices] = useState<Devices | null>(null)
  const [here, setHere] = useState<BrowserState | null>(null)
  const [busy, setBusy] = useState(false)
  const [probing, setProbing] = useState(false)
  const [problem, setProblem] = useState('')
  const [done, setDone] = useState('')

  const load = useCallback(() => {
    api<Devices>('/api/notify/devices').then(setDevices, (error) => setProblem(problemText(error)))
    void browserState().then(setHere)
  }, [])
  useEffect(load, [load])

  const run = async (work: () => Promise<unknown>, success = '') => {
    setBusy(true)
    setProblem('')
    setDone('')
    try {
      await work()
      if (success) setDone(success)
    } catch (error) {
      setProblem(problemText(error))
    } finally {
      setBusy(false)
      load()
    }
  }

  if (!devices || here === null) return problem ? <Notice tone="danger">{problem}</Notice> : null
  const name = (entry: Devices['browsers'][number]) =>
    entry.browser && entry.system ? t('notify.browserOn', { browser: entry.browser, system: entry.system }) : entry.browser || entry.system || t('notify.otherBrowser')
  const note = here === 'denied' ? t('notify.deniedHelp') : here === 'unsupported' ? t('notify.unsupportedHelp') : undefined
  return (
      <NotifyWays
        subtitle={t('settings.notifications.ways')}
        browser={{
          on: here === 'on',
          onTurnOn: () => void run(async () => setHere(await allowBrowser())),
          onTurnOff: () => void run(async () => setHere(await stopBrowser())),
          onProbe:
            here === 'on'
              ? () => {
                  setProbing(true)
                  void run(() => api('/api/notify/webpush/test', { method: 'POST' }), t('settings.notifications.probeSent')).finally(() => setProbing(false))
                }
              : undefined,
          busy,
          probing,
          disabled: here === 'denied' || here === 'unsupported',
          note,
        }}
        browsers={{
          items: devices.browsers.map((entry) => ({
            id: String(entry.id),
            name: name(entry),
            detail: entry.since ? t('settings.notifications.since', { when: dayTime(entry.since, i18n.language) }) : undefined,
            current: entry.this,
          })),
          busy,
          onRemove: (id) => {
            const entry = devices.browsers.find((found) => String(found.id) === id)
            if (entry?.this) void run(async () => setHere(await stopBrowser()))
            else void run(() => api(`/api/notify/webpush/${encodeURIComponent(id)}`, { method: 'DELETE' }))
          },
        }}
        devices={{
          href: areaPath('connections'),
          note: devices.apps.length ? t('settings.notifications.apps', { count: devices.apps.length }) : undefined,
        }}
      >
        {problem && <Notice tone="danger" testId="notify-problem">{problem}</Notice>}
        {done && <Notice tone="ok" testId="notify-done">{done}</Notice>}
      </NotifyWays>
  )
}
