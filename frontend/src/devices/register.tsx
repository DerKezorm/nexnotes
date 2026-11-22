/**
 * The app for iPhone, iPad and Mac (NOTES-24) docks onto the frame: "Geräte" first in Settings, Connections (drawing
 * N2-Verbindungen, before nextasks and the keys). The page `/app-connect` the app opens to sign in is a route of
 * `App.tsx`, outside the shell.
 */
import { CONNECTION_SECTIONS } from '../extensions'
import { DevicesSection } from './DevicesSection'

if (!CONNECTION_SECTIONS.some((section) => section.key === 'devices')) {
  CONNECTION_SECTIONS.unshift({ key: 'devices', render: () => <DevicesSection /> })
}
