/**
 * My account › Connections, place 3 (plan "Einstellungen", "Entwurf Apps verbinden"): one card per other nex app of
 * the catalog in use (nextasks, nexlore, nextime), from the module verbinden with its logos. nextasks keeps its older
 * way as "Von Hand verbinden" (a key typed in, NOTES-19); its "Bereiche und Listen" stand open in the card, however it
 * is connected (V23). Since verbinden 0.1.8 only the operator sets the other apps up ("Einrichten") and starts a new
 * connection by hand; a key typed in before stays the account's to change (V46).
 */
import { useTranslation } from 'react-i18next'

import { AreaChoice, NextasksSection } from '../nextasks/NextasksSection'
import { useMe } from '../state/auth'
import { ConnectionsArea, ConnectionsOperatorCard } from '../vendor/nexverbinden'
import { connectRequest, leave } from './words'

/** Where nexnotes reaches nextasks' lists: connected with a click, or with a key typed in. */
const WITH_LISTS = new Set(['connected', 'legacy', 'expiring'])

export function AppsArea() {
  const { t, i18n } = useTranslation()
  const operator = useMe()?.role === 'operator'
  return (
    <ConnectionsArea
      app="nexnotes"
      operator={operator}
      request={connectRequest}
      manual={{ nextasks: <NextasksSection bare /> }}
      extra={(view) => (view.partner === 'nextasks' && WITH_LISTS.has(view.state) ? <AreaChoice /> : null)}
      areaWord={t('tokens.dialog.folders')}
      language={i18n.language}
      navigate={(address) => leave.to(address)}
    />
  )
}

/** Server › General: "Andere nex-Apps", the switch and the addresses of the other apps (V14), and since verbinden 0.1.8
 * the one place of "Verbindungen ins eigene Netz" (nexnotes' own switch in "Funktionen für alle Konten" is gone; its
 * way `PUT /api/settings` with `connections_local_network` stays, E55). */
export function AppsOperator() {
  const { i18n } = useTranslation()
  return <ConnectionsOperatorCard app="nexnotes" request={connectRequest} language={i18n.language} />
}
