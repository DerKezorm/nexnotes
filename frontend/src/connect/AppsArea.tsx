/**
 * My account › Connections, place 3 (plan "Einstellungen", "Entwurf Apps verbinden"): one card per other nex app of
 * the catalog (nextasks, nexlore, nextime), from the module verbinden. nextasks keeps its older way as "Von Hand
 * verbinden" (a key typed in, NOTES-19) and its "Bereiche und Listen" while connected.
 */
import { useTranslation } from 'react-i18next'

import { moment } from '../lib/time'
import { AreaChoice, NextasksSection } from '../nextasks/NextasksSection'
import { ConnectionsArea, ConnectionsOperatorCard } from '../vendor/nexverbinden'
import { LOGOS, connectRequest, leave } from './words'

export function AppsArea() {
  const { t, i18n } = useTranslation()
  return (
    <ConnectionsArea
      app="nexnotes"
      request={connectRequest}
      logos={LOGOS}
      manual={{ nextasks: <NextasksSection bare /> }}
      extra={(view) => (view.partner === 'nextasks' ? <AreaChoice /> : null)}
      areaWord={t('tokens.dialog.folders')}
      language={i18n.language}
      when={(iso, language) => moment(iso, language)}
      navigate={(address) => leave.to(address)}
    />
  )
}

/** Server › General: "Andere nex-Apps", the switch and the addresses of the other apps (V14). */
export function AppsOperator() {
  const { i18n } = useTranslation()
  return <ConnectionsOperatorCard app="nexnotes" request={connectRequest} language={i18n.language} />
}
