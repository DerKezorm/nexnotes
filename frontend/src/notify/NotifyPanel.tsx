/**
 * The switch of a note or a folder with what belongs to it (drawing "N14-Mitteilungen"): on or off (AC-1), that it
 * bundles and leaves out one's own changes, the member's devices with their state, this browser with "Erlauben" (AC-7,
 * AC-8) or how to allow it again (EC-3), and how a notification looks (AC-8).
 */
import { Bell } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Check } from '../components/Check'
import { LogoMark } from '../components/Logo'
import { problemText } from '../lib/errors'
import { notifyApi, type NotifyKind, type NotifySettings } from './api'
import { allowBrowser, browserState, stopBrowser, type BrowserState } from './browser'
import './notify.css'

export function NotifyPanel({ kind, id, onChange }: { kind: NotifyKind; id: string; onChange?: (on: boolean) => void }) {
  const { t } = useTranslation()
  const [settings, setSettings] = useState<NotifySettings | null>(null)
  const [browser, setBrowser] = useState<BrowserState | null>(null)
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    notifyApi.get(kind, id).then(
      (found) => {
        setSettings(found)
        setProblem('')
      },
      (error) => setProblem(problemText(error)),
    )
  }, [kind, id])
  useEffect(load, [load])
  useEffect(() => {
    void browserState().then(setBrowser)
  }, [])

  const toggle = async () => {
    if (!settings || busy) return
    setBusy(true)
    try {
      const next = await notifyApi.set(kind, id, !settings.on)
      setSettings(next)
      onChange?.(next.on)
    } catch (error) {
      setProblem(problemText(error))
    } finally {
      setBusy(false)
    }
  }

  const allow = async () => {
    setBusy(true)
    try {
      setBrowser(await allowBrowser())
      load()
    } catch (error) {
      setProblem(problemText(error))
    } finally {
      setBusy(false)
    }
  }

  const stop = async () => {
    setBusy(true)
    try {
      setBrowser(await stopBrowser())
      load()
    } catch (error) {
      setProblem(problemText(error))
    } finally {
      setBusy(false)
    }
  }

  if (!settings)
    return problem ? (
      <p className="text-[13px] text-bad-500" role="alert">
        {problem}
      </p>
    ) : null

  if (!settings.shared)
    return (
      <p className="text-[13px] leading-relaxed text-mist-300" data-testid="notify-not-shared">
        {t(kind === 'note' ? 'notify.notSharedNote' : 'notify.notSharedFolder')}
      </p>
    )

  const others = settings.devices.browsers.filter((each) => !each.this)
  return (
    <div className="flex flex-col gap-3.5" data-testid="notify-panel">
      <label className="flex items-center justify-between gap-3">
        <span className="flex flex-col gap-0.5">
          <span className="text-[15px] font-bold">{t(kind === 'note' ? 'notify.titleNote' : 'notify.titleFolder')}</span>
          <span className="text-[12.5px] text-mist-500">{t('notify.when')}</span>
        </span>
        <Check checked={settings.on} aria-label={t('notify.switch')} data-testid="notify-switch" disabled={busy} onChange={() => void toggle()} />
      </label>
      {settings.via && (
        <span className="text-[12.5px] text-mist-500" data-testid="notify-via">
          {t(settings.on ? 'notify.viaOn' : 'notify.viaOff', { name: settings.via.name })}
        </span>
      )}
      {kind === 'folder' && <span className="text-[13px] leading-relaxed text-mist-300">{t('notify.folderBelow')}</span>}
      <span className="text-[13px] leading-relaxed text-mist-300">{t('notify.bundled')}</span>

      <div className="flex flex-col gap-2 rounded-[10px] border border-ink-700 bg-ink-900 p-3" data-testid="notify-devices">
        <span className="text-xs text-mist-500">{t('notify.devices')}</span>
        {settings.devices.apps.map((app) => (
          <span key={`app-${app.id}`} className="flex justify-between gap-3 text-[13.5px]">
            <span className="min-w-0 truncate">{app.name}</span>
            {app.on ? <span className="text-ok-500">{t('notify.on')}</span> : <span className="text-mist-500" data-testid="notify-app-off">{t('notify.off')}</span>}
          </span>
        ))}
        {others.map((each) => (
          <span key={`web-${each.id}`} className="flex justify-between gap-3 text-[13.5px]">
            <span className="min-w-0 truncate">{browserName(each.browser, each.system, t)}</span>
            <span className="text-ok-500">{t('notify.on')}</span>
          </span>
        ))}
        <span className="flex items-center justify-between gap-3 text-[13.5px]" data-testid="notify-this-browser" data-state={browser ?? ''}>
          <span>{t('notify.thisBrowser')}</span>
          {browser === 'on' && (
            <span className="flex items-center gap-2">
              <span className="text-ok-500">{t('notify.on')}</span>
              <button type="button" className="nn-btn nn-btn-quiet h-8 px-2 text-[12.5px]" disabled={busy} onClick={() => void stop()} data-testid="notify-stop">
                {t('notify.stop')}
              </button>
            </span>
          )}
          {browser === 'off' && (
            <button type="button" className="nn-btn nn-btn-accent h-8 px-2.5 text-[12.5px]" disabled={busy} onClick={() => void allow()} data-testid="notify-allow">
              {t('notify.allow')}
            </button>
          )}
          {browser === 'denied' && <span className="text-warn-500">{t('notify.denied')}</span>}
          {browser === 'unsupported' && <span className="text-mist-500">{t('notify.unsupported')}</span>}
        </span>
        {browser === 'denied' && (
          <span className="text-[12.5px] leading-relaxed text-mist-300" data-testid="notify-denied-help">
            {t('notify.deniedHelp')}
          </span>
        )}
        {browser === 'unsupported' && <span className="text-[12.5px] leading-relaxed text-mist-300">{t('notify.unsupportedHelp')}</span>}
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-mist-500">{t('notify.preview')}</span>
        <div className="flex items-start gap-2.5 rounded-xl bg-ink-700 px-3 py-2.5" data-testid="notify-preview">
          <LogoMark size={26} />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate text-[13px] font-semibold">{settings.preview.title}</span>
            <span className="text-[12.5px] text-mist-300">{settings.preview.text}</span>
          </span>
        </div>
      </div>
      {problem && (
        <p className="text-[13px] text-bad-500" role="alert">
          {problem}
        </p>
      )}
    </div>
  )
}

function browserName(browser: string, system: string, t: (key: string, values?: Record<string, string>) => string): string {
  if (browser && system) return t('notify.browserOn', { browser, system })
  return browser || system || t('notify.otherBrowser')
}

/** The bell's look: pressed while notifications are on (drawing "N14-Mitteilungen"). */
export function BellIcon({ on }: { on: boolean }) {
  return <Bell aria-hidden className={'h-[18px] w-[18px] ' + (on ? 'text-accent-400' : '')} strokeWidth={2} />
}
