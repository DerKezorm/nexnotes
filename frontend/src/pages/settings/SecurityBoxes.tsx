/**
 * Parts of "Sign-in and security" that came with the shared account module (part 2): the passkeys, "Where you are
 * signed in", and after a password set through a link "These devices still have access" with "Disconnect all". Only
 * nexnotes' own building blocks (the boxes of the security card, `Field`, `Dialog`), words from `account.*`.
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { authApi, passkeysApi, type AccessEntry, type PasskeyEntry, type SessionEntry } from '../../api/client'
import { Dialog } from '../../components/Dialog'
import { Field } from '../../components/Field'
import { problemText } from '../../lib/errors'
import { dayTime } from '../../lib/format'
import { addPasskey, passkeysSupported } from '../../lib/passkeys'

const QUIET = 'nn-btn nn-btn-ghost h-8 px-3 text-xs font-medium'
const LOUD = 'nn-btn nn-btn-accent'
const PLAIN = 'nn-btn nn-btn-ghost'
const BOX = 'rounded-[12px] border border-ink-700 px-3 py-2.5'

/** A success worth a sentence that is not the usual "saved" (thrown to end an action early). */
// eslint-disable-next-line react-refresh/only-export-components
export class Notice extends Error {}

/** The own passkeys: list, add (password first), remove. */
export function PasskeysBox({ signedInByPassword }: { signedInByPassword: boolean }) {
  const { t, i18n } = useTranslation()
  const [keys, setKeys] = useState<PasskeyEntry[] | null>(null)
  const [asking, setAsking] = useState<{ kind: 'add' } | { kind: 'remove'; uid: string } | null>(null)
  const [password, setPassword] = useState('')
  const [label, setLabel] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => {
    passkeysApi.list().then(setKeys, () => setKeys([]))
  }, [])
  useEffect(load, [load])
  if (keys === null) return null
  const act = async () => {
    if (!asking) return
    setBusy(true)
    setProblem(null)
    try {
      if (asking.kind === 'add') await addPasskey(password, label.trim())
      else await passkeysApi.remove(asking.uid, password)
      setAsking(null)
      setPassword('')
      setLabel('')
      load()
    } catch (error) {
      setProblem(error instanceof Error && error.message === 'passkey_cancelled' ? null : problemText(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className={BOX} data-testid="passkeys">
      <h3 className="mb-1 text-sm font-medium text-mist-100">{t('account.passkeys')}</h3>
      <p className="mb-2 text-xs text-mist-500">{t('account.passkeysHint')}</p>
      {keys.length > 0 && (
        <ul className="mb-2 divide-y divide-ink-700 text-sm">
          {keys.map((key) => (
            <li key={key.uid} className="flex flex-wrap items-center gap-2 py-1.5">
              <span className="min-w-0 flex-1 truncate">{key.name || t('account.passkeys')}</span>
              <span className="text-xs text-mist-500">{dayTime(key.last_used_at ?? key.created_at, i18n.language)}</span>
              <button type="button" className={QUIET} onClick={() => setAsking({ kind: 'remove', uid: key.uid })}>
                {t('account.passkeyRemove')}
              </button>
            </li>
          ))}
        </ul>
      )}
      {passkeysSupported() && (
        <button type="button" className={QUIET} onClick={() => setAsking({ kind: 'add' })}>
          {t('account.passkeyAdd')}
        </button>
      )}
      {asking && (
        <Dialog title={asking.kind === 'add' ? t('account.passkeyAdd') : t('account.passkeyRemove')} onClose={() => setAsking(null)}>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault()
              void act()
            }}
          >
            {asking.kind === 'add' && <Field label={t('account.passkeyName')} value={label} onChange={setLabel} maxLength={100} />}
            {signedInByPassword ? (
              <Field label={t('account.currentPassword')} value={password} onChange={setPassword} type="password" autoComplete="current-password" autoFocus />
            ) : (
              <p className="text-sm text-mist-400">{t('account.confirmFresh')}</p>
            )}
            {problem && <p role="alert" className="text-sm text-bad-500">{problem}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" className={PLAIN} onClick={() => setAsking(null)}>
                {t('common.cancel')}
              </button>
              <button type="submit" disabled={busy || (signedInByPassword && !password)} className={LOUD}>
                {asking.kind === 'add' ? t('account.passkeyAdd') : t('account.passkeyRemove')}
              </button>
            </div>
          </form>
        </Dialog>
      )}
    </div>
  )
}

/** "Signed-in devices" (``account.sessions``, konten 0.3.6): browsers and paired devices, this browser marked, each
 * signed out alone; under them what "Sign out everywhere else" ends and what stays, and the button. */
export function SessionsBox({ onEverywhere, busy = false }: { onEverywhere: () => Promise<unknown>; busy?: boolean }) {
  const { t, i18n } = useTranslation()
  const [rows, setRows] = useState<SessionEntry[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const load = useCallback(() => {
    authApi.sessions().then(setRows, () => setRows([]))
  }, [])
  useEffect(load, [load])
  if (rows === null) return null
  return (
    <div className={BOX} data-testid="sessions">
      <h3 className="mb-2 text-sm font-medium text-mist-100">{t('account.sessions')}</h3>
      <ul className="divide-y divide-ink-700 text-sm">
        {rows.map((row) => (
          <li key={row.uid} className="flex flex-wrap items-center gap-2 py-1.5">
            <span className="min-w-0 flex-1 truncate" title={row.label}>
              {row.device ? `${t('account.sessionDevice')}: ${row.label}` : row.label || t('account.sessions')}
            </span>
            <span className="text-xs text-mist-500">
              {row.current ? t('account.sessionThis') : dayTime(row.last_seen_at ?? row.created_at, i18n.language)}
            </span>
            {!row.current && (
              <button
                type="button"
                className={QUIET}
                onClick={() => {
                  setProblem(null)
                  authApi.endSession(row.uid).then(load, (error) => setProblem(problemText(error)))
                }}
              >
                {t('account.sessionSignOut')}
              </button>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-mist-500">{t('account.signOutEverywhereHint')}</p>
      <button type="button" disabled={busy} className={QUIET + ' mt-2'} data-testid="sign-out-everywhere" onClick={() => void onEverywhere().then(load)}>
        {t('account.signOutEverywhere')}
      </button>
      {problem && <p role="alert" className="mt-2 text-sm text-bad-500">{problem}</p>}
    </div>
  )
}

/** After a password set through a link: what still has access, "Disconnect all", or put the list away. */
export function RemainingAccess({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation()
  const [entries, setEntries] = useState<AccessEntry[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => {
    authApi.access().then((answer) => setEntries(answer.access), () => setEntries([]))
  }, [])
  if (entries === null) return null
  const finish = (call: () => Promise<unknown>) => {
    setProblem(null)
    call().then(onDone, (error) => setProblem(problemText(error)))
  }
  return (
    <div role="note" className="rounded-[12px] border border-warn-500/40 bg-warn-500/10 px-4 py-3 text-sm" data-testid="remaining-access">
      {entries.length > 0 ? (
        <>
          <p className="font-medium text-warn-500">{t('account.remainingAccess')}</p>
          <ul className="mt-1 list-disc pl-5 text-mist-300">
            {entries.map((entry) => (
              <li key={`${entry.kind}-${entry.id}`}>{entry.label}</li>
            ))}
          </ul>
        </>
      ) : (
        <p className="text-mist-300">{t('account.resetByOperator')}</p>
      )}
      {problem && <p role="alert" className="mt-2 text-bad-500">{problem}</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        {entries.length > 0 && (
          <button type="button" className={LOUD} onClick={() => finish(() => authApi.disconnectAll())}>
            {t('account.disconnectAll')}
          </button>
        )}
        <button type="button" className={PLAIN} onClick={() => finish(() => authApi.accessSeen())}>
          {t('common.done')}
        </button>
      </div>
    </div>
  )
}

/** The emergency hammer is down (``NEXNOTES_SECOND_FACTOR_OFF``, the shared module's ``NOTICES``): said plainly at the
 * top of the own account and of the operator's sign-in settings, as long as the server says so. */
export function SecondFactorOffNotice({ on }: { on?: boolean }) {
  const { t } = useTranslation()
  if (!on) return null
  return (
    <div role="note" className="rounded-[12px] border border-warn-500/40 bg-warn-500/10 px-4 py-3 text-sm" data-testid="second-factor-off">
      <p className="font-medium text-warn-500">{t('account.secondFactorOff')}</p>
      <p className="mt-1 text-mist-300">{t('account.secondFactorOffHint')}</p>
    </div>
  )
}
