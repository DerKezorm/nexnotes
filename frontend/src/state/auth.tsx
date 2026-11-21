/**
 * Who is signed in. `loading` until the server answered, `setup` while nexnotes has no account yet, `signedOut`,
 * or `signedIn` with the account.
 *
 * A session that ends while the page is open does not throw the page away: what is being written stays on screen.
 * `interrupted` says why: `expired` (the session ran out; a dialog asks to sign in again, and afterwards
 * `SIGNED_IN_AGAIN_EVENT` lets every editor save what waited, NOTES-2 EC-3) or `blocked` (the operator blocked or
 * deleted the account: "Your account is blocked", and nothing more is saved, NOTES-2 EC-4).
 *
 * Signing out and every change of the account in the tab forget what the stores kept of the account before
 * (`state/account.ts`), before the next account's page is drawn. The open page asks now and then who is signed in; if
 * another tab signed in as someone else meanwhile, this page follows at once; changes typed here for the account
 * before that still waited are lost then, and the notice at the bottom says how many.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { ApiError, authApi, SIGNED_OUT_EVENT, type Me } from '../api/client'
import { showNotice } from '../folders/notice'
import i18n, { changeLanguage } from '../i18n'
import { followAccount } from './account'

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
    // Before anything of this account is drawn: the stores forget the one before.
    const lost = followAccount(next.id)
    if (lost > 0) showNotice({ text: i18n.t('session.lostChanges', { count: lost, name: next.display_name || next.name }) }, 15_000)
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
        followAccount(null)
        setStatus('signedOut')
        setMeState(null)
        return
      }
      setMe(await authApi.me())
    } catch (error) {
      setStatus('signedOut')
      if (error instanceof ApiError && error.status === 401) {
        followAccount(null)
        setMeState(null)
      }
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

  const meId = useRef<number | null>(null)
  meId.current = me?.id ?? null

  useEffect(() => {
    if (status !== 'signedIn' || interrupted) return
    // A 401 sends SIGNED_OUT_EVENT (api/client.ts); anything else, such as the server restarting, changes nothing.
    // Another account (signed in in another tab, the cookie is shared): the page follows it.
    const ask = () => {
      if (document.visibilityState !== 'visible') return
      void authApi
        .me()
        .then((now) => {
          if (now && typeof now.id === 'number' && meId.current !== null && now.id !== meId.current) setMe(now)
        })
        .catch(() => undefined)
    }
    const session = window.setInterval(ask, SESSION_MS)
    document.addEventListener('visibilitychange', ask)
    return () => {
      window.clearInterval(session)
      document.removeEventListener('visibilitychange', ask)
    }
  }, [status, interrupted, setMe])

  const signOut = useCallback(async () => {
    await authApi.logout().catch(() => undefined)
    followAccount(null)
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

/** The account signed in, or null; also outside the provider (a part drawn on its own, as in a test). */
// eslint-disable-next-line react-refresh/only-export-components
export function useAccountId(): number | null {
  return useContext(Context)?.me?.id ?? null
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
