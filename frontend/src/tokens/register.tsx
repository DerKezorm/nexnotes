/**
 * API keys (NOTES-25) and AI tools (NOTES-20) dock onto Settings, Connections as the shared key module's cards
 * (`KeysCards.tsx`, plan "Einstellungen", Verbindungen 5 and 6): after the devices, installing and nextasks, before the
 * vault password where one stands there.
 */
import { CONNECTION_SECTIONS } from '../extensions'
import { ConnectionKeys } from './KeysCards'

if (!CONNECTION_SECTIONS.some((section) => section.key === 'tokens')) {
  const vault = CONNECTION_SECTIONS.findIndex((section) => section.key === 'vault')
  const section = { key: 'tokens', render: () => <ConnectionKeys /> }
  if (vault === -1) CONNECTION_SECTIONS.push(section)
  else CONNECTION_SECTIONS.splice(vault, 0, section)
}
