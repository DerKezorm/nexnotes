/**
 * The two pages of connecting with another nex app (module verbinden): the consent at `/connect/app` (another app asks
 * to connect with nexnotes) and the return at `/connect/return` (back from the other app's consent). Since verbinden
 * 0.1.8 (B5, V48) the pages bring their own frame (`PAGE_FRAME`, in the middle of the window); nexnotes only hands
 * them its client, its words and the way out.
 */
import { useTranslation } from 'react-i18next'
import { useLocation } from 'react-router-dom'

import { ConsentPage, ReturnPage } from '../vendor/nexverbinden'
import { connectRequest, leave } from './words'

export function Consent() {
  const { t, i18n } = useTranslation()
  const { search } = useLocation()
  return <ConsentPage request={connectRequest} search={search} areaWord={t('tokens.dialog.folders')} language={i18n.language} navigate={(address) => leave.to(address)} />
}

export function Return() {
  const { i18n } = useTranslation()
  const { search } = useLocation()
  return <ReturnPage app="nexnotes" request={connectRequest} search={search} language={i18n.language} navigate={(address) => leave.to(address)} />
}
