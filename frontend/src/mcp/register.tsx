/**
 * MCP access (NOTES-20, module mcp) docks onto the frame with two pages: the consent page a connecting program sends
 * its member to (`/oauth/authorize`, "Programm verbinden") and the page of one request that waits for the member's
 * answer (`/mcp/requests/<id>`). Keys for MCP and the rights per tool are in the card "KI-Werkzeuge (MCP)"
 * (`src/tokens/KeysCards.tsx`).
 */
import { FEATURE_ROUTES } from '../extensions'
import { Consent, Request } from './Pages'

if (!FEATURE_ROUTES.some((route) => route.path === 'oauth/authorize')) FEATURE_ROUTES.push({ path: 'oauth/authorize', element: <Consent /> })
if (!FEATURE_ROUTES.some((route) => route.path === 'mcp/requests/:id')) FEATURE_ROUTES.push({ path: 'mcp/requests/:id', element: <Request /> })
