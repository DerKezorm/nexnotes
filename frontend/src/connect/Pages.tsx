/**
 * The two pages of connecting with another nex app (module verbinden): the consent at `/connect/app` (another app asks
 * to connect with nexnotes) and the return at `/connect/return` (back from the other app's consent).
 */
import { useTranslation } from 'react-i18next'
import { useLocation } from 'react-router-dom'

import { ConsentPage, ReturnPage } from '../vendor/nexverbinden'
import { connectRequest, leave } from './words'

export function Consent() {
  const { t, i18n } = useTranslation()
  const { search } = useLocation()
  return (
    <div className="mx-auto w-full max-w-md p-6">
      <ConsentPage request={connectRequest} search={search} areaWord={t('tokens.dialog.folders')} language={i18n.language} navigate={(address) => leave.to(address)} />
    </div>
  )
}

export function Return() {
  const { i18n } = useTranslation()
  const { search } = useLocation()
  return (
    <div className="mx-auto w-full max-w-md p-6">
      <ReturnPage app="nexnotes" request={connectRequest} search={search} language={i18n.language} navigate={(address) => leave.to(address)} />
    </div>
  )
}
