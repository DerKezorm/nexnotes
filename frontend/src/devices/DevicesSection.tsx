/**
 * Settings, Connections: "Geräte" (NOTES-24 AC-5, plan "Einstellungen", Verbindungen 1). Every connected iPhone, iPad
 * and Mac with its name, its kind (iOS app, iPad app on the Mac), its last contact, whether notifications are on (a
 * badge), and "Trennen": the device reaches nothing from that moment on. "iPhone oder iPad verbinden" opens the QR code
 * (AC-1, N24-Koppeln). Built from the ui kit.
 */
import { Laptop, Smartphone, Tablet } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { problemText } from '../lib/errors'
import { formatMoment } from '../vendor/nexui'
import { Badge, Box, Button, Buttons, Card, ConfirmDialog, Notice, Row, Rows, useNexuiTexts } from '../vendor/nexui'
import { devicesApi, type AppDevice } from './api'
import { ConnectDialog } from './ConnectDialog'

const ICONS = { ios: Smartphone, ipados: Tablet, mac: Laptop }

export function DevicesSection() {
  const { t, i18n } = useTranslation()
  const kit = useNexuiTexts()
  const [devices, setDevices] = useState<AppDevice[] | null>(null)
  const [problem, setProblem] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [leaving, setLeaving] = useState<AppDevice | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => devicesApi.list().then(setDevices, (error) => setProblem(problemText(error))), [])
  useEffect(() => {
    void load()
  }, [load])

  const disconnect = async (device: AppDevice) => {
    setProblem('')
    setBusy(true)
    try {
      await devicesApi.disconnect(device.id)
    } catch (error) {
      setProblem(problemText(error))
    }
    setBusy(false)
    setLeaving(null)
    await load()
  }

  return (
    <Card id="devices" icon="Smartphone" title={t('devices.section.title')} subtitle={t('devices.section.text')}>
      {problem && <Notice tone="danger">{problem}</Notice>}
      {devices && devices.length === 0 && (
        <p className="m-0 text-sm text-[var(--nexui-text-muted)]" data-testid="devices-none">
          {t('devices.section.none')}
        </p>
      )}
      {devices && devices.length > 0 && (
        <Box title={t('devices.section.title')}>
          <Rows testId="devices-list">
            {devices.map((device) => (
              <Row
                key={device.id}
                icon={ICONS[device.kind] ?? Smartphone}
                name={<span data-testid="device-name">{device.name}</span>}
                badge={<Badge tone={device.push ? 'on' : 'off'}>{device.push ? t('devices.section.push') : t('devices.section.pushOff')}</Badge>}
                sub={
                  <span data-testid="device-meta">
                    {[
                      t(`devices.kind.${device.kind === 'mac' ? 'mac' : 'ios'}`),
                      device.last_seen_at ? t('devices.section.lastSeen', { when: formatMoment(device.last_seen_at, i18n.language) }) : t('devices.section.neverSeen'),
                    ].join(' · ')}
                  </span>
                }
                action={
                  <Button kind="danger" size="sm" icon="Unplug" onClick={() => setLeaving(device)} testId="device-disconnect">
                    {t('devices.section.disconnect')}
                  </Button>
                }
                testId="device-row"
              />
            ))}
          </Rows>
        </Box>
      )}
      <Buttons>
        <Button kind="primary" icon="Smartphone" onClick={() => setConnecting(true)} testId="devices-connect">
          {t('devices.section.connect')}
        </Button>
      </Buttons>
      {connecting && (
        <ConnectDialog
          onClose={() => {
            setConnecting(false)
            void load()
          }}
        />
      )}
      {leaving && (
        <ConfirmDialog
          title={t('devices.section.disconnectTitle', { name: leaving.name })}
          text={t('devices.section.disconnectText')}
          confirm={{ label: t('devices.section.disconnect'), kind: 'danger', icon: 'Unplug' }}
          cancel={t('common.cancel')}
          closeLabel={kit.close}
          busy={busy}
          onCancel={() => setLeaving(null)}
          onConfirm={() => void disconnect(leaving)}
          testId="device-disconnect-dialog"
        />
      )}
    </Card>
  )
}
