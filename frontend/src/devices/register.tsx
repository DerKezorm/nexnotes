/**
 * The app for iPhone, iPad and Mac (NOTES-24) docks onto the frame with the module geraete's card "Geräte" (list,
 * connecting by QR code or code, renaming, disconnecting), first in Mein Konto › Verbindungen. The page
 * `/app-connect` the app opens to sign in is a route of `App.tsx`, outside the shell; the kinds of notification per
 * device are a card of Mein Konto › Benachrichtigungen, an account's devices a part of Server › Konten › Verwalten.
 */
import { CONNECTION_SECTIONS } from '../extensions'
import { DevicesSection } from './DevicesSection'

if (!CONNECTION_SECTIONS.some((section) => section.key === 'devices')) {
  CONNECTION_SECTIONS.unshift({ key: 'devices', render: () => <DevicesSection /> })
}
