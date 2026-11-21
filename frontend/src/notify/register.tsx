/**
 * Notifications (NOTES-14) dock onto the frame (`extensions.ts`): over every page of the signed-in app the service
 * worker is there, a browser that allowed notifications is signed up again after a new sign-in, and a tapped
 * notification opens its note in the page that is already open (the worker hands the address over).
 */
import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

import { SHELL_PARTS } from '../extensions'
import { pushSupported, renewBrowser } from './browser'
import { insidePath, OPEN_MESSAGE } from './open'

export function NotifyShell() {
  const navigate = useNavigate()
  useEffect(() => {
    if (!pushSupported()) return
    renewBrowser().catch(() => {})
    const heard = (event: MessageEvent) => {
      if (event.data?.type !== OPEN_MESSAGE) return
      const path = insidePath(event.data.url)
      if (path) navigate(path)
    }
    navigator.serviceWorker.addEventListener('message', heard)
    return () => navigator.serviceWorker.removeEventListener('message', heard)
  }, [navigate])
  return null
}

SHELL_PARTS.push({ key: 'notify', render: () => <NotifyShell /> })
