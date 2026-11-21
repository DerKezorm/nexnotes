import '@fontsource-variable/inter'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'

import App from './App'
// The note features dock onto the frame before the first render (extensions.ts).
import './folders'
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
