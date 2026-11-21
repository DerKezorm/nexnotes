/**
 * The vault's dialogs and cards (NOTES-16, drawings N16-Tresor-einrichten, N16-Tresor-entsperren, Handy-Tresor and the
 * vault part of N2-Verbindungen):
 *
 * - **Set up** at the first lock (AC-1): the password twice, the warning that a forgotten one means the content is
 *   gone, the box "Ich habe verstanden …" before locking, and that the title stays readable (AC-6).
 * - **Lock** with a vault already there: the password only (AC-8).
 * - **Open** a locked note: the password; wrong ones counted by the server, after three a wait with its countdown
 *   (EC-1); "Passwort vergessen?".
 * - **Take the lock off** (AC-4), **a new password** (AC-5), **forgotten** (EC-2: a new vault, every locked note
 *   goes, said with their number; the account's password and second factor once more, or a fresh sign-in at its
 *   provider, so that a stolen session cannot destroy the locked notes).
 * - A server naming a derivation weaker than this page takes (`checkKdf`) opens nothing: the forms say so.
 */
import { Lock, LockOpen } from 'lucide-react'
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { ApiError } from '../api/client'
import { Dialog } from '../components/Dialog'
import { problemText } from '../lib/errors'
import { SignInAgain } from '../pages/settings/ui'
import { useMe } from '../state/auth'
import { notesChanged } from '../notes/api'
import { clock } from './clock'
import { changePassword, lockNote, resetVault, setUpVault, unlockNote } from './actions'
import { vaultApi, type VaultStatus } from './api'
import { isOpen, openVault, type OpenResult } from './session'

/** The shortest vault password the page takes: the server never sees it and cannot check it. */
export const MIN_LENGTH = 8

function PasswordInput({ label, value, onChange, invalid, autoFocus, testId, describedBy, readOnly }: { label: string; value: string; onChange: (value: string) => void; invalid?: boolean; autoFocus?: boolean; testId: string; describedBy?: string; readOnly?: boolean }) {
  return (
    <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-mist-100">
      {label}
      <input
        type="password"
        className="nn-field"
        value={value}
        // Never kept by the browser: no saved password, no autofill of another one (EC-6).
        autoComplete="new-password"
        spellCheck={false}
        autoFocus={autoFocus}
        readOnly={readOnly}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        data-testid={testId}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  )
}

function Warning({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="rounded-[10px] px-3.5 py-3 text-[13.5px] leading-relaxed font-medium text-warn-500" style={{ background: 'rgb(251 146 60 / 0.14)' }} data-testid="vault-warning">
      {children}
    </div>
  )
}

/** A wait counted down to the second (EC-1). */
function useCountdown(): [number, (seconds: number) => void] {
  const [until, setUntil] = useState(0)
  const [left, setLeft] = useState(0)
  useEffect(() => {
    if (!until) return
    const tick = () => {
      const rest = Math.max(0, Math.ceil((until - Date.now()) / 1000))
      setLeft(rest)
      if (!rest) setUntil(0)
    }
    tick()
    const timer = setInterval(tick, 250)
    return () => clearInterval(timer)
  }, [until])
  return [left, (seconds: number) => setUntil(seconds > 0 ? Date.now() + seconds * 1000 : 0)]
}

/** What a password form says after a try. */
function useTries() {
  const { t } = useTranslation()
  const [message, setMessage] = useState('')
  const [left, startWait] = useCountdown()
  const take = (result: OpenResult): boolean => {
    if (result.ok) {
      setMessage('')
      return true
    }
    if (result.reason === 'wrong') {
      setMessage(result.wait > 0 ? t('vault.unlock.tooMany') : t('vault.unlock.wrong', { count: result.left }))
      startWait(result.wait)
    } else if (result.reason === 'wait') {
      setMessage(t('vault.unlock.tooMany'))
      startWait(result.wait)
    } else if (result.reason === 'weak') setMessage(t('errors.vault_weak_kdf'))
    else setMessage(t('errors.vault_missing'))
    return false
  }
  return { message, setMessage, waiting: left, take, startWait }
}

// --- Set up (AC-1) and lock (AC-8) ------------------------------------------------------------------------------

function SetupForm({ submitLabel, onSubmit, onCancel, busy, children }: { submitLabel: string; onSubmit: (password: string) => void; onCancel: () => void; busy: boolean; children?: ReactNode }) {
  const { t } = useTranslation()
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [understood, setUnderstood] = useState(false)
  const [tried, setTried] = useState(false)
  const tooShort = password.length < MIN_LENGTH
  const differs = again !== password
  const submit = (event: FormEvent) => {
    event.preventDefault()
    setTried(true)
    if (tooShort || differs || !understood) return
    onSubmit(password)
  }
  return (
    <form className="flex flex-col gap-3.5" onSubmit={submit} data-testid="vault-setup">
      <p className="text-sm leading-relaxed text-mist-400">{t('vault.setup.text')}</p>
      <Warning>{t('vault.setup.warning')}</Warning>
      <PasswordInput label={t('vault.password')} value={password} onChange={setPassword} invalid={tried && tooShort} autoFocus testId="vault-password" />
      <PasswordInput label={t('vault.repeat')} value={again} onChange={setAgain} invalid={tried && differs} testId="vault-repeat" />
      {tried && tooShort && <p className="text-[12.5px] text-bad-500">{t('vault.tooShort', { count: MIN_LENGTH })}</p>}
      {tried && !tooShort && differs && <p className="text-[12.5px] text-bad-500">{t('vault.differs')}</p>}
      <label className="flex items-start gap-2.5 text-[13.5px] leading-snug text-mist-100">
        <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--color-accent-500)]" checked={understood} onChange={(event) => setUnderstood(event.target.checked)} data-testid="vault-understood" />
        {t('vault.setup.understood')}
      </label>
      {tried && !understood && <p className="text-[12.5px] text-bad-500">{t('vault.setup.tick')}</p>}
      <p className="text-[12.5px] text-mist-500" data-testid="vault-title-hint">
        {t('vault.titleHint')}
      </p>
      {children}
      <div className="flex justify-end gap-2">
        <button type="button" className="nn-btn nn-btn-ghost" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button type="submit" className="nn-btn nn-btn-accent" disabled={busy || !understood} data-testid="vault-submit">
          {submitLabel}
        </button>
      </div>
    </form>
  )
}

/** While the password is checked (the derivation takes a moment, WebCrypto off the page's thread) the button says what
 * happens and the field holds still: what is typed meanwhile would be emptied with the answer. */
function PasswordForm({ submitLabel, workingLabel, onOpened, onCancel, busy, onForgot }: { submitLabel: string; workingLabel: string; onOpened: () => void; onCancel?: () => void; busy?: boolean; onForgot?: () => void }) {
  const { t } = useTranslation()
  const [password, setPassword] = useState('')
  const [working, setWorking] = useState(false)
  const tries = useTries()
  const id = useId()
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!password || tries.waiting) return
    setWorking(true)
    try {
      const result = await openVault(password)
      setPassword('')
      if (tries.take(result)) onOpened()
    } catch (error) {
      tries.setMessage(problemText(error))
    } finally {
      setWorking(false)
    }
  }
  return (
    <form className="flex flex-col gap-3" onSubmit={(event) => void submit(event)} aria-busy={working || undefined} data-testid="vault-unlock">
      <PasswordInput label={t('vault.password')} value={password} onChange={setPassword} invalid={Boolean(tries.message)} autoFocus testId="vault-password" describedBy={tries.message ? id : undefined} readOnly={working} />
      {tries.message && (
        <p id={id} role="alert" className="text-[12.5px] font-medium text-bad-500" data-testid="vault-message">
          {tries.message}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {onForgot && (
          <button type="button" className="nn-btn nn-btn-quiet mr-auto text-[13px] text-accent-400" onClick={onForgot} data-testid="vault-forgot">
            {t('vault.forgot.link')}
          </button>
        )}
        {onCancel && (
          <button type="button" className="nn-btn nn-btn-ghost" onClick={onCancel}>
            {t('common.cancel')}
          </button>
        )}
        <button type="submit" className="nn-btn nn-btn-accent" disabled={working || busy || tries.waiting > 0 || !password} data-testid="vault-submit">
          {working ? workingLabel : tries.waiting > 0 ? t('vault.unlock.wait', { time: clock(tries.waiting) }) : submitLabel}
        </button>
      </div>
    </form>
  )
}

/** "Sperren" in a note's menu: set up at the first lock (AC-1), the password with a vault there (AC-8). */
export function LockDialog({ noteId, onClose }: { noteId: string; onClose: () => void }) {
  const { t } = useTranslation()
  const [status, setStatus] = useState<VaultStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const [progress, setProgress] = useState('')
  useEffect(() => {
    vaultApi.status().then(setStatus, (error) => setProblem(problemText(error)))
  }, [])
  const lock = async () => {
    setBusy(true)
    setProblem('')
    try {
      await lockNote(noteId, (done, of) => setProgress(t('vault.progress', { done, of })))
      notesChanged()
      onClose()
    } catch (error) {
      setProblem(problemText(error))
      setProgress('')
    } finally {
      setBusy(false)
    }
  }
  // With the vault open in this tab nothing is asked again.
  useEffect(() => {
    if (status?.set_up && isOpen() && !busy && !problem && !progress) void lock()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status])
  const title = status && !status.set_up ? t('vault.setup.title') : t('vault.lock.title')
  return (
    <Dialog title={title} onClose={onClose} lead={<Lead />}>
      <div className="flex flex-col gap-3" data-testid="vault-lock-dialog">
        {status && !status.set_up && (
          <SetupForm
            submitLabel={t('vault.lock.submit')}
            busy={busy}
            onCancel={onClose}
            onSubmit={(password) => {
              setBusy(true)
              setUpVault(password).then(lock, (error) => {
                setProblem(problemText(error))
                setBusy(false)
              })
            }}
          />
        )}
        {status?.set_up && !isOpen() && (
          <>
            <p className="text-sm leading-relaxed text-mist-400">{t('vault.lock.text')}</p>
            <PasswordForm submitLabel={t('vault.lock.submit')} workingLabel={t('vault.working.lock')} onCancel={onClose} busy={busy} onOpened={() => void lock()} />
          </>
        )}
        {/* From the first moment of the work, not only from the first part encrypted: the password form is gone then
            and the dialog would stand empty. */}
        {(busy || progress) && (
          <p className="text-[12.5px] text-mist-500" aria-live="polite" data-testid="vault-progress">
            {progress || t('vault.working.lock')}
          </p>
        )}
        {problem && <p className="text-sm text-bad-500">{problem}</p>}
      </div>
    </Dialog>
  )
}

function Lead() {
  return (
    <span className="grid h-9 w-9 place-items-center rounded-[10px] bg-accent-wash text-accent-400">
      <Lock className="h-[18px] w-[18px]" aria-hidden />
    </span>
  )
}

// --- Open a locked note (AC-3, AC-7, EC-1) ----------------------------------------------------------------------

/** The card instead of a locked note's text (drawing N16-Tresor-entsperren, on the phone Handy-Tresor). */
export function UnlockCard({ title, onOpened }: { title: string; onOpened?: () => void }) {
  const { t } = useTranslation()
  const [forgot, setForgot] = useState(false)
  return (
    <article className="flex w-full max-w-[760px] flex-col gap-4 px-5 py-6 md:px-10 md:py-7" data-testid="locked-note">
      <span className="flex items-center gap-3">
        <span className="text-[28px] font-bold tracking-tight text-mist-100" data-testid="locked-title">
          {title || t('notes.untitled')}
        </span>
        <Lock role="img" aria-label={t('noteList.locked')} className="h-5 w-5 shrink-0 text-mist-400" />
      </span>
      <div className="flex w-full max-w-[420px] flex-col gap-3 rounded-[16px] border border-ink-700 bg-ink-850 p-5">
        <span className="text-base font-bold text-mist-100">{t('vault.unlock.title')}</span>
        <span className="text-[13.5px] leading-relaxed text-mist-400">{t('vault.unlock.text')}</span>
        <PasswordForm submitLabel={t('vault.unlock.submit')} workingLabel={t('vault.working.unlock')} onOpened={() => onOpened?.()} onForgot={() => setForgot(true)} />
      </div>
      {forgot && <ForgotDialog onClose={() => setForgot(false)} />}
    </article>
  )
}

// --- Take the lock off (AC-4) -----------------------------------------------------------------------------------

export function RemoveLockDialog({ noteId, onClose, onDone }: { noteId: string; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const [progress, setProgress] = useState('')
  const remove = async () => {
    setBusy(true)
    setProblem('')
    try {
      await unlockNote(noteId, (done, of) => setProgress(t('vault.progress', { done, of })))
      notesChanged()
      onDone()
    } catch (error) {
      setProblem(problemText(error))
      setProgress('')
      setBusy(false)
    }
  }
  return (
    <Dialog title={t('vault.remove.title')} onClose={onClose} lead={<span className="grid h-9 w-9 place-items-center rounded-[10px] bg-accent-wash text-accent-400"><LockOpen className="h-[18px] w-[18px]" aria-hidden /></span>}>
      <div className="flex flex-col gap-3" data-testid="vault-remove-dialog">
        <p className="text-sm leading-relaxed text-mist-400">{t('vault.remove.text')}</p>
        <PasswordForm submitLabel={t('vault.remove.submit')} workingLabel={t('vault.working.remove')} onCancel={onClose} busy={busy} onOpened={() => void remove()} />
        {(busy || progress) && (
          <p className="text-[12.5px] text-mist-500" aria-live="polite" data-testid="vault-progress">
            {progress || t('vault.working.remove')}
          </p>
        )}
        {problem && <p className="text-sm text-bad-500">{problem}</p>}
      </div>
    </Dialog>
  )
}

// --- A new password (AC-5), forgotten (EC-2) ------------------------------------------------------------------

export function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const [old, setOld] = useState('')
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const [done, setDone] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (password.length < MIN_LENGTH) return setProblem(t('vault.tooShort', { count: MIN_LENGTH }))
    if (password !== again) return setProblem(t('vault.differs'))
    setBusy(true)
    setProblem('')
    try {
      const result = await changePassword(old, password)
      if (result === 'ok') setDone(true)
      else setProblem(result === 'wait' ? t('vault.unlock.tooMany') : result === 'weak' ? t('errors.vault_weak_kdf') : t('vault.change.wrong'))
    } catch (error) {
      setProblem(problemText(error))
    } finally {
      setBusy(false)
      setOld('')
    }
  }
  return (
    <Dialog title={t('vault.change.title')} onClose={onClose}>
      {done ? (
        <div className="flex flex-col gap-3" data-testid="vault-changed">
          <p className="text-sm text-mist-300">{t('vault.change.done')}</p>
          <div className="flex justify-end">
            <button type="button" className="nn-btn nn-btn-accent" onClick={onClose}>
              {t('common.close')}
            </button>
          </div>
        </div>
      ) : (
        <form className="flex flex-col gap-3" onSubmit={(event) => void submit(event)} data-testid="vault-change">
          <p className="text-sm leading-relaxed text-mist-400">{t('vault.change.text')}</p>
          <PasswordInput label={t('vault.change.old')} value={old} onChange={setOld} autoFocus testId="vault-old" />
          <PasswordInput label={t('vault.change.new')} value={password} onChange={setPassword} testId="vault-password" />
          <PasswordInput label={t('vault.repeat')} value={again} onChange={setAgain} testId="vault-repeat" />
          {problem && (
            <p role="alert" className="text-[12.5px] font-medium text-bad-500">
              {problem}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" className="nn-btn nn-btn-ghost" onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button type="submit" className="nn-btn nn-btn-accent" disabled={busy || !old} data-testid="vault-submit">
              {t('vault.change.submit')}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  )
}

export function ForgotDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const me = useMe()
  const [status, setStatus] = useState<VaultStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const [refusal, setRefusal] = useState<ApiError | null>(null)
  const [removed, setRemoved] = useState<number | null>(null)
  // Who it is, once more (the server asks it, deps.confirm_fresh): an account of a provider signs in there again.
  const withPassword = !me || me.sign_in === 'password'
  const withCode = withPassword && Boolean(me?.two_factor)
  const [accountPassword, setAccountPassword] = useState('')
  const [code, setCode] = useState('')
  useEffect(() => {
    vaultApi.status().then(setStatus, (error) => setProblem(problemText(error)))
  }, [])
  const count = status?.locked_all ?? 0
  return (
    <Dialog title={t('vault.forgot.title')} onClose={onClose}>
      <div className="flex flex-col gap-3" data-testid="vault-forgot-dialog">
        {removed !== null ? (
          <>
            <p className="text-sm text-mist-300" data-testid="vault-forgot-done">
              {t('vault.forgot.done', { count: removed })}
            </p>
            <div className="flex justify-end">
              <button type="button" className="nn-btn nn-btn-accent" onClick={onClose}>
                {t('common.close')}
              </button>
            </div>
          </>
        ) : (
          status && (
            <>
              <Warning>
                <span data-testid="vault-forgot-count">{t('vault.forgot.warning', { count })}</span>
              </Warning>
              <SetupForm
                submitLabel={t('vault.forgot.submit', { count })}
                busy={busy}
                onCancel={onClose}
                onSubmit={(password) => {
                  if (withPassword && !accountPassword) return setProblem(t('vault.forgot.accountMissing'))
                  setBusy(true)
                  setProblem('')
                  setRefusal(null)
                  resetVault(password, count, { current_password: accountPassword, code }).then(
                    (gone) => {
                      setRemoved(gone)
                      notesChanged()
                    },
                    (error) => {
                      setProblem(problemText(error))
                      setRefusal(error instanceof ApiError ? error : null)
                      setBusy(false)
                      setAccountPassword('')
                      setCode('')
                      vaultApi.status().then(setStatus, () => undefined)
                    },
                  )
                }}
              >
                <fieldset className="flex flex-col gap-2.5 border-t border-ink-700 pt-3" data-testid="vault-forgot-confirm">
                  <legend className="pt-1 text-[13px] font-semibold text-mist-100">{t('vault.forgot.confirm')}</legend>
                  {withPassword ? (
                    <>
                      <PasswordInput label={t('vault.forgot.account')} value={accountPassword} onChange={setAccountPassword} testId="vault-account-password" />
                      {withCode && (
                        <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-mist-100">
                          {t('vault.forgot.code')}
                          <input className="nn-field" value={code} inputMode="numeric" autoComplete="one-time-code" spellCheck={false} onChange={(event) => setCode(event.target.value)} data-testid="vault-account-code" />
                        </label>
                      )}
                    </>
                  ) : (
                    <p className="text-[12.5px] leading-relaxed text-mist-400">{t('vault.forgot.provider', { minutes: 10 })}</p>
                  )}
                </fieldset>
              </SetupForm>
            </>
          )
        )}
        {problem && <p className="text-sm text-bad-500">{problem}</p>}
        {refusal?.code === 'fresh_sign_in_required' && <SignInAgain providers={refusal.values.providers} />}
      </div>
    </Dialog>
  )
}
