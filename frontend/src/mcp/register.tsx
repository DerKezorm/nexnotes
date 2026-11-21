/**
 * MCP access (NOTES-20) docks onto the frame: its part of Settings, Connections (after devices and nextasks, before
 * the vault password, drawing N2-Verbindungen) and the consent page a connecting program sends its member to.
 */
import { CONNECTION_SECTIONS, FEATURE_ROUTES } from '../extensions'
import { ConsentPage } from './ConsentPage'
import { McpKeysSection } from './McpKeysSection'

if (!CONNECTION_SECTIONS.some((section) => section.key === 'mcp')) {
  const vault = CONNECTION_SECTIONS.findIndex((section) => section.key === 'vault')
  const section = { key: 'mcp', render: () => <McpKeysSection /> }
  if (vault === -1) CONNECTION_SECTIONS.push(section)
  else CONNECTION_SECTIONS.splice(vault, 0, section)
}
if (!FEATURE_ROUTES.some((route) => route.path === 'oauth/authorize')) FEATURE_ROUTES.push({ path: 'oauth/authorize', element: <ConsentPage /> })
