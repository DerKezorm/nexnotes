/**
 * Settings, Connections: "Geräte" (NOTES-24 AC-5, drawing N2-Verbindungen). Every connected iPhone, iPad and Mac with
 * its name, its kind (iOS app, iPad app on the Mac), its last contact and whether notifications are on, and "Trennen":
 * the device reaches nothing from that moment on. "iPhone oder iPad verbinden" opens the QR code (AC-1, N24-Koppeln).
 */
import { Laptop, Smartphone, Tablet } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '../components/Dialog'
import { Problem } from '../components/Field'
import { problemText } from '../lib/errors'
import { ago } from '../lib/time'
import { Card } from '../pages/settings/ui'
import { devicesApi, type AppDevice } from './api'
import { ConnectDialog } from './ConnectDialog'

const ICONS = { ios: Smartphone, ipados: Tablet, mac: Laptop }

export function DevicesSection() {
  const { t, i18n } = useTranslation()
  const [devices, setDevices] = useState<AppDevice[] | null>(null)
  const [problem, setProblem] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [leaving, setLeaving] = useState<AppDevice | null>(null)

  const load = useCallback(() => devicesApi.list().then(setDevices, (error) => setProblem(problemText(error))), [])
  useEffect(() => {
    void load()
  }, [load])

  const disconnect = async (device: AppDevice) => {
    setProblem('')
    try {
      await devicesApi.disconnect(device.id)
    } catch (error) {
      setProblem(problemText(error))
    }
    setLeaving(null)
    await load()
  }

  return (
    <Card id="devices" icon={Smartphone} title={t('devices.section.title')} text={t('devices.section.text')}>
      <Problem text={problem} />
      {devices && devices.length === 0 && (
        <p className="text-sm text-mist-500" data-testid="devices-none">
          {t('devices.section.none')}
        </p>
      )}
      {devices && devices.length > 0 && (
        <ul className="flex flex-col" data-testid="devices-list">
          {devices.map((device) => {
            const Icon = ICONS[device.kind] ?? Smartphone
            const meta = [
              t(`devices.kind.${device.kind === 'mac' ? 'mac' : 'ios'}`),
              device.last_seen_at ? t('devices.section.lastSeen', { when: ago(new Date(device.last_seen_at).getTime(), i18n.language) }) : t('devices.section.neverSeen'),
              ...(device.push ? [t('devices.section.push')] : []),
            ]
            return (
              <li key={device.id} className="flex items-center gap-3 border-b border-ink-800 py-2.5 last:border-0" data-testid="device-row">
                <Icon className="h-5 w-5 shrink-0 text-mist-300" strokeWidth={1.8} aria-hidden />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-sm text-mist-100" data-testid="device-name">
                    {device.name}
                  </span>
                  <span className="text-xs text-mist-500" data-testid="device-meta">
                    {meta.join(' · ')}
                  </span>
                </span>
                <button type="button" className="nn-btn nn-btn-ghost" onClick={() => setLeaving(device)} data-testid="device-disconnect">
                  {t('devices.section.disconnect')}
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <div>
        <button type="button" className="nn-btn nn-btn-accent" onClick={() => setConnecting(true)} data-testid="devices-connect">
          {t('devices.section.connect')}
        </button>
      </div>
      {connecting && (
        <ConnectDialog
          onClose={() => {
            setConnecting(false)
            void load()
          }}
        />
      )}
      {leaving && (
        <Dialog title={t('devices.section.disconnectTitle', { name: leaving.name })} onClose={() => setLeaving(null)}>
          <p className="text-sm text-mist-300">{t('devices.section.disconnectText')}</p>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className="nn-btn nn-btn-ghost" onClick={() => setLeaving(null)}>
              {t('common.cancel')}
            </button>
            <button type="button" className="nn-btn nn-btn-danger" onClick={() => void disconnect(leaving)} data-testid="device-disconnect-confirm">
              {t('devices.section.disconnect')}
            </button>
          </div>
        </Dialog>
      )}
    </Card>
  )
}
