/**
 * Connecting nexnotes with the other nex apps (module verbinden) docks onto the frame: the cards of the partner apps in
 * Settings, Connections (where nextasks' own card stood, after the devices, before the MCP keys) and the pages of the
 * consent and the return.
 */
import { CONNECTION_SECTIONS, FEATURE_ROUTES } from '../extensions'
import { AppsArea } from './AppsArea'
import { Consent, Return } from './Pages'

if (!CONNECTION_SECTIONS.some((section) => section.key === 'apps')) {
  const after = CONNECTION_SECTIONS.findIndex((section) => section.key === 'tokens' || section.key === 'mcp' || section.key === 'vault')
  const section = { key: 'apps', render: () => <AppsArea /> }
  if (after === -1) CONNECTION_SECTIONS.push(section)
  else CONNECTION_SECTIONS.splice(after, 0, section)
}
if (!FEATURE_ROUTES.some((route) => route.path === 'connect/app')) FEATURE_ROUTES.push({ path: 'connect/app', element: <Consent /> })
if (!FEATURE_ROUTES.some((route) => route.path === 'connect/return')) FEATURE_ROUTES.push({ path: 'connect/return', element: <Return /> })
