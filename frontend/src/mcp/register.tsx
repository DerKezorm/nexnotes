/**
 * MCP access (NOTES-20) docks onto the frame with the consent page a connecting program sends its member to. Keys for
 * MCP are API tokens with "Auch für KI-Werkzeuge (MCP)" since NOTES-25 (`src/tokens/`).
 */
import { FEATURE_ROUTES } from '../extensions'
import { ConsentPage } from './ConsentPage'

if (!FEATURE_ROUTES.some((route) => route.path === 'oauth/authorize')) FEATURE_ROUTES.push({ path: 'oauth/authorize', element: <ConsentPage /> })
