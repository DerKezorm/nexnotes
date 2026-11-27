/** Mein Konto › Verbindungen, place 1: the module geraete's card "Geräte" with nexnotes' client and words. */
import { useTranslation } from 'react-i18next'

import { areaPath } from '../pages/settings/areas'
import { useAuth } from '../state/auth'
import { DevicesCard } from '../vendor/nexgeraete'
import { deviceRequest } from './request'

export function DevicesSection() {
  const { i18n } = useTranslation()
  const { me } = useAuth()
  return <DevicesCard request={deviceRequest} app="nexnotes" language={i18n.language} operator={me?.role === 'operator'} serverHref={areaPath('server-connections')} />
}
