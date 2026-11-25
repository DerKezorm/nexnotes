/**
 * Settings › Connections: "Auf diesem Gerät installieren" (plan "Einstellungen", Verbindungen 2, E6): what installing
 * gives, and the browser's own install question as a button, or on iPhone and iPad the way through Share › Add to Home
 * Screen. Nothing when there is nothing to do: in the installed app, and in a browser that offers no installing.
 */
import { Share } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, Buttons, Card } from '../vendor/nexui'
import { install, usePwa } from './worker'

export function InstallCard() {
  const { t } = useTranslation()
  const { installable, ios, standalone } = usePwa()
  const [asked, setAsked] = useState(false)
  if (standalone || (!installable && !ios && !asked)) return null
  return (
    <Card id="install" icon="Download" title={t('pwa.install.title')} subtitle={t('pwa.install.text')}>
      {installable && (
        <Buttons>
          <Button
            kind="primary"
            icon="Download"
            onClick={() => {
              setAsked(true)
              void install()
            }}
            testId="install"
          >
            {t('pwa.install.button')}
          </Button>
        </Buttons>
      )}
      {!installable && ios && (
        <p className="m-0 flex items-start gap-2 text-sm text-[var(--nexui-text)]" data-testid="install-ios">
          <Share className="mt-0.5 h-4 w-4 shrink-0 text-[var(--nexui-accent-text)]" aria-hidden /> {t('pwa.install.ios')}
        </p>
      )}
      {!installable && !ios && asked && <p className="m-0 text-sm text-[var(--nexui-text-muted)]">{t('pwa.install.asked')}</p>}
    </Card>
  )
}
