import '@fontsource-variable/inter'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'

import App from './App'
// The note features dock onto the frame before the first render (extensions.ts).
import './notes/register'
import './folders'
// "Anhänge" right after the inbox among the places (drawing "Seitenleiste").
import './attachments'
// "Mit mir geteilt" right after the inbox, before "Anhänge" (drawing "Seitenleiste"); sharing (NOTES-13).
import './shares'
// The recognised text of pictures, scans and PDFs: their large view, and hits of the search in them.
import './ocr'
import './search'
import './tags'
import './history'
import './export'
// Locked notes: their view in the editor's place, the menu entries, the part of Settings, Connections.
import './vault'
// Notifications (NOTES-14): the bell of a shared note, the service worker, Web Push.
import './notify'
// The trash closes the sidebar's places (drawing "Seitenleiste"): imported after every feature with an entry there.
import './trash'
import './i18n'
import { followSystem } from './lib/theme'
import { bearTranslatedPages } from './lib/translatedPage'
import { AuthProvider } from './state/auth'
import './styles/index.css'

followSystem()
bearTranslatedPages()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
)
