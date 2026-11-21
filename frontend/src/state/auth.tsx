/**
 * Who is signed in. `loading` until the server answered, `setup` while nexnotes has no account yet, `signedOut`,
 * or `signedIn` with the account.
 *
 * A session that ends while the page is open does not throw the page away: what is being written stays on screen.
 * `interrupted` says why: `expired` (the session ran out; a dialog asks to sign in again, and afterwards
 * `SIGNED_IN_AGAIN_EVENT` lets every editor save what waited, NOTES-2 EC-3) or `blocked` (the operator blocked or
 * deleted the account: "Your account is blocked", and nothing more is saved, NOTES-2 EC-4).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

import { ApiError, authApi, SIGNED_OUT_EVENT, type Me } from '../api/client'
import i18n, { changeLanguage } from '../i18n'

type Status = 'loading' | 'setup' | 'signedOut' | 'signedIn'
export type Interruption = 'expired' | 'blocked' | null

/** Sent on `window` once the account signed in again after its session ran out: whatever waited is saved now. */
export const SIGNED_IN_AGAIN_EVENT = 'nexnotes:signed-in-again'

type Auth = {
  status: Status
  me: Me | null
  /** The session ended while the page was open, and why. */
  interrupted: Interruption
  /** The page was sent to the sign-in because its session ended (not by signing out here). */
  ended: boolean
  refresh: () => Promise<void>
  setMe: (me: Me) => void
  signOut: () => Promise<void>
  /** Signed in again in the dialog: the page goes on where it was. */
  resume: (me: Me) => void
}

const Context = createContext<Auth | null>(null)

/** How often an open page asks whether its session still holds: a block shows within seconds. */
export const SESSION_MS = 5_000

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading')
  const [me, setMeState] = useState<Me | null>(null)
  const [interrupted, setInterrupted] = useState<Interruption>(null)
  const [ended, setEnded] = useState(false)

  const setMe = useCallback((next: Me) => {
    setMeState(next)
    setInterrupted(null)
    setEnded(false)
    setStatus('signedIn')
    // The account's language wins over the browser's, on every device (NOTES-22 AC-2).
    if (next.language && next.language !== i18n.language) void changeLanguage(next.language, false)
  }, [])

  const refresh = useCallback(async () => {
    try {
      const state = await authApi.setupState()
      if (state.needs_setup) {
        setStatus('setup')
        return
      }
      if (!state.signed_in) {
        setStatus('signedOut')
        setMeState(null)
        return
      }
      setMe(await authApi.me())
    } catch (error) {
      setStatus('signedOut')
      if (error instanceof ApiError && error.status === 401) setMeState(null)
    }
  }, [setMe])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    const gone = (event: Event) => {
      const code = (event as CustomEvent<{ code?: string }>).detail?.code
      // Signed in a moment ago: keep the page and say why; otherwise there is nothing on screen to keep.
      setStatus((now) => {
        if (now === 'signedIn') {
          setInterrupted(code === 'account_blocked' ? 'blocked' : 'expired')
          return now
        }
        setEnded(true)
        return 'signedOut'
      })
    }
    window.addEventListener(SIGNED_OUT_EVENT, gone)
    return () => window.removeEventListener(SIGNED_OUT_EVENT, gone)
  }, [])

  useEffect(() => {
    if (status !== 'signedIn' || interrupted) return
    // A 401 sends SIGNED_OUT_EVENT (api/client.ts); anything else, such as the server restarting, changes nothing.
    const ask = () => {
      if (document.visibilityState === 'visible') void authApi.me().catch(() => undefined)
    }
    const session = window.setInterval(ask, SESSION_MS)
    document.addEventListener('visibilitychange', ask)
    return () => {
      window.clearInterval(session)
      document.removeEventListener('visibilitychange', ask)
    }
  }, [status, interrupted])

  const signOut = useCallback(async () => {
    await authApi.logout().catch(() => undefined)
    setEnded(false)
    setInterrupted(null)
    setMeState(null)
    setStatus('signedOut')
  }, [])

  const resume = useCallback(
    (next: Me) => {
      setMe(next)
      window.dispatchEvent(new Event(SIGNED_IN_AGAIN_EVENT))
    },
    [setMe],
  )

  const value = useMemo(
    () => ({ status, me, interrupted, ended, refresh, setMe, signOut, resume }),
    [status, me, interrupted, ended, refresh, setMe, signOut, resume],
  )
  return <Context.Provider value={value}>{children}</Context.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): Auth {
  const value = useContext(Context)
  if (!value) throw new Error('useAuth outside AuthProvider')
  return value
}

/** Only addresses inside nexnotes, so a link cannot send someone elsewhere after signing in. */
// eslint-disable-next-line react-refresh/only-export-components
export function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/'
}
